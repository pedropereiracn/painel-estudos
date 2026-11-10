#!/bin/bash
# Teste do backend do painel. Usa diretório de dados temporário e porta própria:
# nunca toca em data/ real. Uso: ./test.sh
set -u
cd "$(dirname "$0")"
NODE=${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}
export PAINEL_DISCIPLINAS=CALC,FIS,PROG,ELET,REDES,GEST
export PORT=${TEST_PORT:-4799}
export PAINEL_DATA_DIR=$(mktemp -d -t painel-teste)
export PAINEL_CAL_SYNC=0
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0; PID=""

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FALHA $1"; if [ -n "${2:-}" ]; then echo "        $2"; fi; return 0; }
fim()  { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -rf "$PAINEL_DATA_DIR"; }
trap fim EXIT

sobe() {
  $NODE server.js >>"$PAINEL_DATA_DIR/server.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "$B/api/state" && return 0; sleep 0.1; done
  echo "servidor não subiu"; cat "$PAINEL_DATA_DIR/server.log"; exit 1
}
desce() { kill "$PID"; wait "$PID" 2>/dev/null; PID=""; }

# js: avalia expressão JS com o JSON da entrada em `s`. Imprime "true" ou o erro.
js() { $NODE -e '
  let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{
    try{const s=JSON.parse(t);const r=('"$1"');console.log(r===true?"true":"false: "+JSON.stringify(r).slice(0,300))}
    catch(e){console.log("erro: "+e.message+" | "+t.slice(0,200))}})'; }
check() { # check "descricao" "json" "expressao"
  local r; r=$(printf '%s' "$2" | js "$3")
  if [ "$r" = "true" ]; then ok "$1"; else bad "$1" "$r"; fi
}
post() { curl -s -X POST -H 'Content-Type: application/json' -d "$2" "$B$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

D0=$(date +%F); D1=$(date -v+1d +%F); D9=$(date -v+9d +%F); D2=$(date -v+2d +%F); D5=$(date -v+5d +%F); D12=$(date -v+12d +%F); DM20=$(date -v-20d +%F)
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ); OLD_ISO=$(date -u -v-3d +%Y-%m-%dT%H:%M:%SZ)

echo "== subindo em $B, dados em $PAINEL_DATA_DIR"
sobe

echo "== 1. estado vazio"
S=$(curl -s "$B/api/state")
check "State tem as 6 matérias" "$S" 'Object.keys(s.materias).join()==="CALC,FIS,PROG,ELET,REDES,GEST"'
check "ranking com 6 itens" "$S" 's.ranking.length===6'
check "recomendação nula sem dado" "$S" 's.recomendacao.materia===null && typeof s.recomendacao.motivo==="string"'
check "config padrão 3/6" "$S" 's.config.horas_dia_semana===3 && s.config.horas_dia_fds===6'
check "6 alertas de sem dado" "$S" 's.alertas.filter(a=>/não mandou dado/.test(a.texto)).length===6'
check "por_dia tem 14 dias e por_hora 24" "$S" 's.estudo.por_dia.length===14 && s.estudo.por_hora.length===24'
check "calendário vazio: ok false, 21 dias vindos da rotina padrão" "$S" 's.calendario.ok===false && s.calendario.por_dia.length===21 && s.calendario.por_dia.every(d=>typeof d.ocupado_h==="number"&&typeof d.livre_h==="number") && s.calendario.eventos.length===0'
check "sem rotina.json: plano com rotina padrão e rotina_ok false" "$S" 's.plano.rotina_ok===false && s.plano.dias.length===7'
check "padrão sem amostra" "$S" 's.padrao.amostra_suficiente===false && s.padrao.agora_e_boa_hora===null'
[ "$(code "$B/")" = "200" ] && ok "GET / responde 200" || bad "GET / responde 200"

# seções 2 a 9 testam o motor sem plano: rotina sem janela livre (a recomendação não vira fila)
echo '{"acorda":"05:30","dorme":"05:31","preparo_min":0,"dias":{}}' > "$PAINEL_DATA_DIR/rotina.json"
echo "== 2. POST de matérias"
CALC=$(cat <<EOF
{"sigla":"CALC","nome":"Ciência de Dados","professor":null,"atualizado_em":"$NOW_ISO",
 "formula_nota":"0.4 P1 + 0.6 P2","media_aprovacao":7,
 "notas":[{"item":"P1","peso":0.4,"nota":5.5,"max":10,"data":"$DM20"}],
 "nota_necessaria":{"valor":8.0,"em":"P2","explicacao":"x"},
 "avaliacoes":[{"id":"lab4","tipo":"outro","titulo":"Lab 4: relatório","data":"$D1","hora":"10:00","peso":null,"status":"pendente","topicos":[],"confirmada":true},
               {"id":"p2","tipo":"prova","titulo":"Prova 2","data":"$D2","hora":"19:00","peso":0.6,"status":"pendente","topicos":["reg","clus","pca"],"confirmada":true},
               {"id":"tde","tipo":"tde","titulo":"TDE 3","data":"$D12","hora":null,"peso":0.1,"status":"pendente","confirmada":false}],
 "topicos":[{"id":"reg","nome":"Regressão","bloco":"P2","dificuldade":2,"status":"praticando","exercicios_feitos":10,"exercicios_certos":9,"horas_restantes":1,"ultima_pratica":"$D0"},
            {"id":"clus","nome":"Clustering","bloco":"P2","dificuldade":4,"status":"visto","exercicios_feitos":2,"exercicios_certos":2,"horas_restantes":4,"ultima_pratica":"$DM20"},
            {"id":"pca","nome":"PCA","bloco":"P2","dificuldade":5,"status":"nao_visto","exercicios_feitos":0,"exercicios_certos":0,"horas_restantes":6,"ultima_pratica":null}],
 "horas_restantes_total":null,"particularidades":"x","riscos":["r"],"proximo_passo":"Fazer lista 4 de PCA","log":[]}
EOF
)
check "POST CALC ok" "$(post /api/materia/CALC "$CALC")" 's.ok===true'
PROG=$(cat <<EOF
{"sigla":"PROG","nome":"Otimização","atualizado_em":"$OLD_ISO","media_aprovacao":7,
 "notas":[{"item":"P1","peso":0.5,"nota":8,"max":10}],
 "avaliacoes":[{"id":"p2","tipo":"prova","titulo":"Prova 2","data":"$D5","hora":"08:00","peso":50,"status":"pendente","topicos":[]}],
 "topicos":[{"id":"simplex","nome":"Simplex","bloco":"P2","dificuldade":3,"status":"dominado","exercicios_feitos":0}],
 "horas_restantes_total":2,"proximo_passo":null}
EOF
)
check "POST PROG (sigla minúscula na URL)" "$(post /api/materia/prog "$PROG")" 's.ok===true'
NULO='{"sigla":null,"nome":null,"professor":null,"atualizado_em":null,"formula_nota":null,"media_aprovacao":null,"notas":null,"nota_necessaria":null,"avaliacoes":null,"topicos":null,"dificuldade_p2":null,"horas_restantes_total":null,"particularidades":null,"riscos":null,"proximo_passo":null,"log":null}'
check "POST FIS tudo null" "$(post /api/materia/FIS "$NULO")" 's.ok===true'
LIXO='{"nome":7,"notas":[null,{"nota":"abc"},{"nota":"6,5","peso":"x","max":0}],"avaliacoes":[null,5,{"data":"2026-02-31","hora":"99:99","peso":"muito"},{"titulo":"Sem data","status":"pendente"}],"topicos":[null,{"id":null,"exercicios_feitos":"NaN","exercicios_certos":99,"dificuldade":"alta","ultima_pratica":"ontem"},{"status":"dominado"}],"nota_necessaria":12,"horas_restantes_total":"3"}'
check "POST ELET com tipos errados" "$(post /api/materia/ELET "$LIXO")" 's.ok===true'
check "POST GEST objeto vazio" "$(post /api/materia/GEST '{}')" 's.ok===true'
[ "$(code -X POST -d 'nao json' "$B/api/materia/REDES")" = "400" ] && ok "JSON inválido dá 400" || bad "JSON inválido dá 400"
[ "$(code -X POST -d '[1,2]' "$B/api/materia/REDES")" = "400" ] && ok "array dá 400" || bad "array dá 400"
[ "$(code -X POST -d '{}' "$B/api/materia/XYZ")" = "400" ] && ok "sigla desconhecida dá 400" || bad "sigla desconhecida dá 400"
[ "$(code -X POST -d '{}' "$B/api/materia/..%2F..%2Fx")" = "400" ] && ok "path traversal recusado" || bad "path traversal recusado"
[ -f "$PAINEL_DATA_DIR/materias/PROG.json" ] && ok "arquivo PROG.json gravado em maiúscula" || bad "arquivo PROG.json gravado"

S=$(curl -s "$B/api/state")
check "sem NaN, undefined ou Infinity no que o servidor calcula" "$S" '!/NaN|undefined|Infinity/.test(JSON.stringify({...s,materias:Object.values(s.materias).map(m=>({...m,dados:null}))}))'
check "sem travessão longo no State" "$S" '!JSON.stringify(s).includes(String.fromCharCode(0x2014))'
check "CALC tem recebido_em" "$S" 'typeof s.materias.CALC.recebido_em==="string"'
check "CALC próxima é o Lab 4 (qualquer tipo)" "$S" 's.materias.CALC.calc.proxima_avaliacao.id==="lab4" && s.materias.CALC.calc.proxima_avaliacao.dias_restantes===1'
check "CALC alvo de estudo é Prova 2 em 2 dias" "$S" '(a=>a.id==="p2"&&a.tipo==="prova"&&a.dias_restantes===2&&a.titulo==="Prova 2")(s.materias.CALC.calc.alvo_estudo)'
check "CALC urgência vem da Prova 2 (maior valor), não do lab" "$S" '(f=>f.urgencia===0.667&&f.peso===0.6)(s.ranking.find(r=>r.sigla==="CALC").fatores)'
check "motivo cita a entrega de amanhã em frase curta" "$S" '/Não esquece de entregar Lab 4 amanhã\./.test(s.recomendacao.motivo)'
check "alerta de ação para o lab" "$S" 's.alertas.some(a=>a.materia==="CALC"&&a.nivel==="critico"&&/^Entregar Lab 4 de CALC amanhã/.test(a.texto))'
check "atraso de CALC é para a Prova 2" "$S" 's.alertas.filter(a=>/atrasada/.test(a.texto)&&a.materia==="CALC").every(a=>/para Prova 2/.test(a.texto))'
check "CALC confiança média ponderada em 0..1" "$S" '(c=>c>0&&c<0.5)(s.materias.CALC.calc.confianca)'
check "CALC tópico com 2/2 tem confiança baixa (Beta)" "$S" '(t=>t&&t.confianca<0.6)(s.materias.CALC.calc.topicos_fracos.find(t=>t.id==="clus"))'
check "CALC tópicos fracos ordenados, pca primeiro" "$S" 's.materias.CALC.calc.topicos_fracos[0].id==="pca"'
check "CALC horas_restantes soma bloco = 11" "$S" 's.materias.CALC.calc.horas_restantes===11'
check "CALC folga calculada" "$S" 'typeof s.materias.CALC.calc.folga_h==="number"'
check "CALC nota_atual 5.5, necessária 8" "$S" 's.materias.CALC.calc.nota_atual===5.5 && s.materias.CALC.calc.nota_necessaria===8'
check "CALC exercícios 12/11" "$S" 's.materias.CALC.calc.exercicios_feitos===12 && s.materias.CALC.calc.exercicios_certos===11'
check "PROG desatualizado (>48 h)" "$S" 's.materias.PROG.desatualizado===true'
check "PROG peso 50 vira 0.5" "$S" 's.ranking.find(r=>r.sigla==="PROG").fatores.peso===0.5'
check "PROG progresso 1 (tudo dominado)" "$S" 's.materias.PROG.calc.progresso===1'
check "FIS tudo null: tem_dados, campos null" "$S" '(m=>m.tem_dados&&m.calc.confianca===null&&m.calc.confianca_rotulo==="sem dado"&&m.calc.proxima_avaliacao===null&&m.nome==="FIS")(s.materias.FIS)'
check "ELET com lixo não quebra e tem avaliação sem data" "$S" 's.materias.ELET.calc.proxima_avaliacao.dias_restantes===null && s.materias.ELET.calc.confianca===0.8 && s.materias.ELET.calc.nota_necessaria===12'
check "ELET nota 6,5 lida como 6.5" "$S" 's.materias.ELET.calc.nota_atual===6.5'
check "ranking ordenado e score 0..100" "$S" 's.ranking.every((r,i,a)=>r.score>=0&&r.score<=100&&(i===0||a[i-1].score>=r.score))'
check "fatores em 0..1" "$S" 's.ranking.every(r=>Object.values(r.fatores).every(v=>v>=0&&v<=1))'
check "CALC no topo do ranking" "$S" 's.ranking[0].sigla==="CALC"'
check "recomendação aponta CALC com tópico e próximo passo" "$S" 's.recomendacao.materia==="CALC" && s.recomendacao.topico.id==="pca" && s.recomendacao.proximo_passo==="Fazer lista 4 de PCA"'
check "motivo em português com números" "$S" '/Prova 2 de CALC em 2 dias, vale 60%/.test(s.recomendacao.motivo)'
check "agenda por data, inclui sem data no fim" "$S" 's.agenda[0].materia==="CALC" && s.agenda[s.agenda.length-1].data===null'
check "alerta crítico/atenção de prova em 2 dias" "$S" 's.alertas.some(a=>a.materia==="CALC"&&/em 2 dias/.test(a.texto))'
check "alerta de data não confirmada" "$S" 's.alertas.some(a=>/não confirmada/.test(a.texto))'
check "alerta de desatualizada" "$S" 's.alertas.some(a=>a.materia==="PROG"&&/sem atualização há 3 dias/.test(a.texto))'
check "alerta sem dado só para REDES" "$S" 's.alertas.filter(a=>/não mandou dado/.test(a.texto)).map(a=>a.materia).join()==="REDES"'
check "alertas ordenados por nível" "$S" '(o=>s.alertas.every((a,i,x)=>i===0||o[x[i-1].nivel]<=o[a.nivel]))({critico:0,atencao:1,info:2})'
echo "== 2b. alvo de estudo, valor da avaliação e alertas de ação"
GP=$(cat <<EOF
{"nome":"Gestão","atualizado_em":"$NOW_ISO","horas_restantes_total":30,
 "avaliacoes":[{"id":"lab11","tipo":"outro","titulo":"LAB11 pré-relatório","data":"$D1","peso":null,"status":"pendente","topicos":[],"confirmada":false},
   {"id":"visto3","tipo":"trabalho","titulo":"Visto 3","data":"$D1","peso":0.07,"status":"pendente","topicos":[],"confirmada":false},
   {"id":"tde1","tipo":"tde","titulo":"TDE 1","data":"$D1","peso":0.9,"status":"entregue","topicos":[],"confirmada":false},
   {"id":"rep","tipo":"prova","titulo":"Reposição de aula","data":"$D1","peso":null,"status":"pendente","topicos":[]},
   {"id":"vis","tipo":"prova","titulo":"Vistas da P1","data":"$D2","peso":null,"status":"pendente","topicos":[]},
   {"id":"lista1","tipo":"outro","titulo":"Lista 1","data":"$D2","peso":0.02,"status":"pendente","topicos":["c"]},
   {"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","hora":"19:00","peso":0.4,"status":"pendente","topicos":["a","b"],"confirmada":true}],
 "topicos":[{"id":"a","nome":"A","bloco":"P2","dificuldade":3,"status":"visto","horas_restantes":6},
   {"id":"b","nome":"B","bloco":"P2","dificuldade":2,"status":"dominado","horas_restantes":4},
   {"id":"c","nome":"C fora da P2","bloco":"P2","dificuldade":5,"status":"nao_visto","horas_restantes":20}]}
EOF
)
post /api/materia/GEST "$GP" >/dev/null
S=$(curl -s "$B/api/state")
D1BR="${D1:8:2}/${D1:5:2}"
check "GEST alvo é a P2, não o lab de amanhã" "$S" 's.materias.GEST.calc.alvo_estudo.id==="p2" && s.materias.GEST.calc.proxima_avaliacao.dias_restantes===1'
check "GEST horas só dos tópicos ligados (10, não 30)" "$S" 's.materias.GEST.calc.horas_restantes===10'
check "GEST confiança e progresso só dos ligados" "$S" 's.materias.GEST.calc.confianca===0.47 && s.materias.GEST.calc.progresso===0.5'
check "GEST folga contra a P2 em 9 dias" "$S" '(c=>Math.abs(c.folga_h-(c.horas_disponiveis_ate_prova-10))<0.11)(s.materias.GEST.calc)'
check "prova de 40% em 9 dias vence visto de 7% e lab sem peso amanhã" "$S" '(f=>f.urgencia===0.308&&f.peso===0.4)(s.ranking.find(r=>r.sigla==="GEST").fatores)'
check "alvo ignora reposição de aula e vistas, mesmo tipo prova" "$S" 's.materias.GEST.calc.alvo_estudo.id==="p2"'
check "alvo prefere prova a lista com tópicos e horas" "$S" 's.materias.GEST.calc.alvo_estudo.tipo==="prova" && s.materias.GEST.calc.horas_restantes===10'
check "entregue não conta (TDE 1 de peso 0,9 ignorada)" "$S" '!s.alertas.some(a=>/TDE 1/.test(a.texto)) && s.ranking.find(r=>r.sigla==="GEST").fatores.peso!==0.9'
check "resumo GEST cita a P2 (decisiva e alvo)" "$S" '/^P2 em 9 dias, vale 40%, confiança/.test(s.ranking.find(r=>r.sigla==="GEST").resumo)'
check "alertas de ação do GEST" "$S" 's.alertas.some(a=>a.texto==="Entregar LAB11 pré-relatório de GEST amanhã ('"$D1BR"').") && s.alertas.some(a=>/^Entregar Visto 3 de GEST amanhã/.test(a.texto))'
check "datas não confirmadas viram 1 linha por matéria" "$S" '(x=>x.length===1&&/GEST: 2 datas não confirmadas/.test(x[0].texto))(s.alertas.filter(a=>a.materia==="GEST"&&a.nivel==="info"))'
check "no máximo 1 info de confirmação por matéria" "$S" '["CALC","FIS","PROG","ELET","REDES","GEST"].every(m=>s.alertas.filter(a=>a.materia===m&&/não confirmada/.test(a.texto)).length<=1)'
check "alvo_estudo existe em toda matéria" "$S" 'Object.values(s.materias).every(m=>"alvo_estudo" in m.calc)'
G=$(curl -s "$B/api/materia/calc")
check "GET /api/materia/CALC traz dado + estudo" "$G" 's.nome==="Ciência de Dados" && s.estudo && s.estudo.sessoes===0'
G=$(curl -s "$B/api/materia/REDES")
check "GET matéria sem dado responde tem_dados false" "$G" 's.tem_dados===false && s.estudo.total_min===0'

echo "== 3. timer"
S=$(post /api/timer/start '{"materia":"CALC","topico":"pca"}')
check "start cria timer" "$S" 's.timer && s.timer.materia==="CALC" && s.timer.topico==="pca"'
[ -f "$PAINEL_DATA_DIR/timer.json" ] && ok "timer.json gravado" || bad "timer.json gravado"
S=$(post /api/timer/stop '{"foco":4}')
check "stop com menos de 60 s descarta" "$S" 's.timer===null && s.estudo.total_min===0'
post /api/timer/start '{"materia":"PROG"}' >/dev/null
S=$(post /api/timer/cancel '')
check "cancel descarta" "$S" 's.timer===null && s.estudo.sessoes_recentes.length===0'
[ "$(code -X POST -d '{"materia":"XX"}' "$B/api/timer/start")" = "400" ] && ok "start com matéria inválida dá 400" || bad "start inválido"

echo "== 4. timer sobrevive a restart e vira sessão"
post /api/timer/start '{"materia":"CALC","topico":"clus"}' >/dev/null
desce
INI=$(date -v-25M +%Y-%m-%dT%H:%M:%S-03:00)
printf '{"materia":"CALC","topico":"clus","inicio":"%s"}' "$INI" > "$PAINEL_DATA_DIR/timer.json"
sobe
S=$(curl -s "$B/api/state")
check "timer recarregado do disco" "$S" 's.timer && s.timer.materia==="CALC"'
S=$(post /api/timer/start '{"materia":"PROG"}')
check "start com timer ativo salva o anterior (25 min)" "$S" 's.timer.materia==="PROG" && s.estudo.sessoes_recentes.length===1 && Math.round(s.estudo.sessoes_recentes[0].minutos)===25'
post /api/timer/cancel '' >/dev/null
desce
INI=$(date -v-4H +%Y-%m-%dT%H:%M:%S-03:00)
printf '{"materia":"PROG","topico":null,"inicio":"%s"}' "$INI" > "$PAINEL_DATA_DIR/timer.json"
sobe
S=$(curl -s "$B/api/state")
check "alerta de timer aberto há mais de 3 h" "$S" 's.alertas.some(a=>/Timer de PROG aberto há 4h/.test(a.texto))'
S=$(post /api/timer/stop '{"foco":5,"nota":"rendeu"}')
check "stop salva sessão de 240 min com foco e nota" "$S" '(x=>x&&x.minutos===240&&x.foco===5&&x.nota==="rendeu")(s.estudo.sessoes_recentes.find(r=>r.materia==="PROG"))'

echo "== 5. sessão manual e delete"
S=$(post /api/sessao '{"materia":"CALC","minutos":130,"topico":"pca","foco":3}')
check "sessão manual entra" "$S" 's.estudo.sessoes_recentes.length===3'
check "anti-monotonia: CALC >120 min hoje oferece alternativa" "$S" 's.recomendacao.alternativa && s.recomendacao.alternativa.materia!=="CALC" && /já teve/.test(s.recomendacao.alternativa.motivo)'
check "hoje_min soma as sessões de hoje" "$S" 's.estudo.hoje_min>=130 && s.materias.CALC.estudo.hoje_min>=130'
check "sequência de dias >= 1" "$S" 's.estudo.sequencia_dias>=1'
ID=$($NODE -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const s=JSON.parse(t);console.log(s.estudo.sessoes_recentes.find(x=>x.minutos===130).id)})' <<<"$S")
S=$(curl -s -X DELETE "$B/api/sessao/$ID")
check "DELETE remove a sessão" "$S" '!s.estudo.sessoes_recentes.some(x=>x.minutos===130)'
[ "$(code -X DELETE "$B/api/sessao/naoexiste")" = "404" ] && ok "DELETE inexistente dá 404" || bad "DELETE inexistente"
[ "$(code -X POST -d '{"materia":"CALC","minutos":-5}' "$B/api/sessao")" = "400" ] && ok "minutos negativos dá 400" || bad "minutos negativos"
[ "$(code -X POST -d '{"materia":"CALC","minutos":30,"inicio":"lixo"}' "$B/api/sessao")" = "400" ] && ok "início inválido dá 400" || bad "início inválido"

echo "== 6. padrão por hora (precisa de 8 sessões)"
for h in 09 09 09 10 14 14 21 21 22; do
  post /api/sessao "{\"materia\":\"PROG\",\"minutos\":$([ $h = 09 ] && echo 90 || echo 30),\"inicio\":\"$(date -v-1d +%F)T$h:00:00-03:00\",\"foco\":$([ $h = 09 ] && echo 5 || echo 2)}" >/dev/null
done
S=$(curl -s "$B/api/state")
check "amostra suficiente com 11 sessões" "$S" 's.padrao.amostra_suficiente===true'
check "9h está entre as melhores horas" "$S" 's.padrao.melhores_horas.length===3 && s.padrao.melhores_horas.some(h=>h.hora===9)'
check "texto do padrão em português" "$S" '/^Com \d+ sessões, você rende mais às \d+h/.test(s.padrao.texto)'
check "por_hora acumula minutos às 9h" "$S" 's.estudo.por_hora[9]>=180 && s.estudo.por_hora[10]>=120'
check "por_dia de ontem tem PROG" "$S" 's.estudo.por_dia[12].por_materia.PROG>0'

echo "== 7. config"
S=$(post /api/config '{"horas_dia_semana":4.5}')
check "config atualiza só o campo enviado" "$S" 's.config.horas_dia_semana===4.5 && s.config.horas_dia_fds===6'
[ "$(code -X POST -d '{"horas_dia_fds":30}' "$B/api/config")" = "400" ] && ok "config fora de 0..24 dá 400" || bad "config inválida"

echo "== 8. SSE"
SSE=$(curl -s -N --max-time 2 "$B/api/events")
echo "$SSE" | grep -q '^event: state' && ok "SSE manda evento state ao conectar" || bad "SSE evento inicial"
DADO=$(echo "$SSE" | grep '^data: ' | head -1 | sed 's/^data: //')
check "payload do SSE é State válido" "$DADO" 'Array.isArray(s.ranking) && !!s.materias.CALC'
( sleep 0.7; post /api/materia/REDES '{"nome":"Internet das Coisas"}' >/dev/null ) &
SSE=$(curl -s -N --max-time 2.5 "$B/api/events")
N=$(echo "$SSE" | grep -c '^event: state')
[ "$N" -ge 2 ] && ok "SSE manda novo state após mudança ($N eventos)" || bad "SSE após mudança" "eventos: $N"
echo "$SSE" | grep '^data: ' | tail -1 | sed 's/^data: //' > "$PAINEL_DATA_DIR/ultimo.json"
check "último state do SSE já tem REDES" "$(cat "$PAINEL_DATA_DIR/ultimo.json")" 's.materias.REDES.tem_dados===true'
H=$(curl -s -i -X OPTIONS "$B/api/state" | tr -d '\r' | grep -i '^access-control-allow-origin')
[ "$H" = "Access-Control-Allow-Origin: *" ] && ok "CORS liberado" || bad "CORS" "$H"

echo "== 9. robustez"
echo '{quebrado' > "$PAINEL_DATA_DIR/materias/GEST.json"
S=$(curl -s "$B/api/state")
check "arquivo de matéria corrompido vira sem dado" "$S" 's.materias.GEST.tem_dados===false'
[ "$(code "$B/api/nada")" = "404" ] && ok "rota inexistente dá 404" || bad "rota inexistente"
S=$(curl -s "$B/api/state")
check "State final sem NaN no que o servidor calcula" "$S" '!/NaN|undefined|Infinity/.test(JSON.stringify({...s,materias:Object.values(s.materias).map(m=>({...m,dados:null}))}))'
kill -0 "$PID" 2>/dev/null && ok "servidor segue vivo" || bad "servidor caiu"
ls "$PAINEL_DATA_DIR"/*.tmp "$PAINEL_DATA_DIR"/materias/*.tmp >/dev/null 2>&1 && bad "sobrou arquivo .tmp" || ok "nenhum .tmp sobrando (escrita atômica)"
grep -q 'uncaught\|unhandled' "$PAINEL_DATA_DIR/server.log" && bad "log tem exceção não tratada" "$(grep -m3 'uncaught\|unhandled' "$PAINEL_DATA_DIR/server.log")" || ok "log sem exceção não tratada"
LC_ALL=C grep -q $'\xe2\x80\x94' server.js test.sh && bad "travessão longo no código" || ok "sem travessão longo em server.js e test.sh"

echo "== 10. calendário (arquivo falso, sem tocar no calendário real)"
desce
EV_HH=$(date -v+22M +%H:%M)
EV_INI=$(date -v+22M +%Y-%m-%dT%H:%M:00-03:00)
EV_FIM=$(date -v+82M +%Y-%m-%dT%H:%M:00-03:00)
# rotina vazia das 7h às 23h30, sem descanso, para medir só o calendário
echo '{"acorda":"07:00","dorme":"23:30","preparo_min":0,"descanso_chegada_min":0,"bloco_min":50,"pausa_min":10,"bloco_minimo_min":25,"dias":{}}' > "$PAINEL_DATA_DIR/rotina.json"
cat > "$PAINEL_DATA_DIR/calendario.json" <<EOF
{"ok":true,"erro":null,"sincronizado_em":"$NOW_ISO","eventos":[
 {"titulo":"Reunião de teste","inicio":"$EV_INI","fim":"$EV_FIM","dia_inteiro":false,"calendario":"Pessoal"},
 {"titulo":"ESTÁGIO","inicio":"${D1}T08:00:00-03:00","fim":"${D1}T15:00:00-03:00","dia_inteiro":false,"calendario":"Estágio"},
 {"titulo":"Sobreposto","inicio":"${D1}T14:00:00-03:00","fim":"${D1}T16:00:00-03:00","dia_inteiro":false,"calendario":"Faculdade"},
 {"titulo":"Feriado","inicio":"${D1}T00:00:00-03:00","fim":"${D1}T23:59:59-03:00","dia_inteiro":true,"calendario":"Feriados"},
 {"titulo":"Livre","inicio":"${D1}T18:00:00-03:00","fim":"${D1}T19:00:00-03:00","dia_inteiro":false,"calendario":"Pessoal","disponibilidade":"livre"},
 {"titulo":"Dia cheio","inicio":"${D2}T07:00:00-03:00","fim":"${D2}T23:00:00-03:00","dia_inteiro":false,"calendario":"Faculdade"},
 {"titulo":"lixo","inicio":"nao","fim":null}
]}
EOF
sobe
S=$(curl -s "$B/api/state")
check "calendário ok com eventos válidos (lixo descartado)" "$S" 's.calendario.ok===true && s.calendario.eventos.length===6 && s.calendario.eventos.every(e=>e.titulo&&e.inicio&&e.fim&&typeof e.dia_inteiro==="boolean"&&"calendario" in e)'
check "por_dia tem 21 dias a partir de hoje" "$S" 's.calendario.por_dia.length===21 && s.calendario.por_dia[0].data==="'"$D0"'"'
check "amanhã: união 8h-16h = 8 h ocupadas (dia inteiro e livre não contam)" "$S" 's.calendario.por_dia[1].ocupado_h===8'
check "amanhã: blocos 7h-8h e 16h-23h30 = 430 min (fds corta em 350)" "$S" 's.calendario.por_dia[1].livre_h===([0,6].includes(new Date("'"$D1"'").getUTCDay())?5.8:7.2)'
check "depois de amanhã lotado: só o bloco curto de 23h às 23h30" "$S" 's.calendario.por_dia[2].livre_h===0.5 && s.calendario.por_dia[2].ocupado_h===16'
check "dia sem evento: 830 min em blocos (fds corta em 350)" "$S" '(d=>d.ocupado_h===0&&d.livre_h===([0,6].includes(new Date(d.data).getUTCDay())?5.8:13.8))(s.calendario.por_dia[5])'
check "horas até a Prova 2 de CALC somam livre_h de hoje e amanhã" "$S" 'Math.abs(s.materias.CALC.calc.horas_disponiveis_ate_prova-(s.calendario.por_dia[0].livre_h+s.calendario.por_dia[1].livre_h))<0.15'
check "folga = disponíveis - restantes" "$S" '(c=>Math.abs(c.folga_h-(c.horas_disponiveis_ate_prova-c.horas_restantes))<0.15)(s.materias.CALC.calc)'
check "o plano não põe bloco antes da reunião que começa em 22 min" "$S" '!s.recomendacao.janela || new Date(s.recomendacao.janela.inicio) >= new Date("'"$EV_FIM"'")'
check "fila com frente e por_que em cada item" "$S" 's.recomendacao.fila.every(f=>f.frente&&f.por_que&&f.minutos>0) && (!s.recomendacao.fila.length || /^Próxima janela: /.test(s.recomendacao.motivo))'
desce
PAINEL_CAL_SYNC=1 PAINEL_CAL_BIN=/usr/bin/false sobe
sleep 0.5
S=$(curl -s "$B/api/state")
check "leitor falhando: ok false, erro preenchido, plano só com a rotina" "$S" 's.calendario.ok===false && /falhou/.test(s.calendario.erro) && s.calendario.por_dia.length===21 && s.plano.dias[1].itens.every(i=>i.origem!=="calendario")'
check "leitor falhando: bloco volta ao normal" "$S" 's.recomendacao.bloco_sugerido_min>=30'
kill -0 "$PID" 2>/dev/null && ok "servidor segue vivo com leitor falhando" || bad "servidor caiu com leitor falhando"
desce
echo '{quebrado' > "$PAINEL_DATA_DIR/calendario.json"
sobe
S=$(curl -s "$B/api/state")
check "calendario.json corrompido não derruba" "$S" 's.calendario.ok===false && s.calendario.por_dia.length===21'

echo "== 11. contingentes, simulado, nota projetada, risco e ritmo"
desce
DM1=$(date -v-1d +%F); DM3=$(date -v-3d +%F); DM5=$(date -v-5d +%F); D3=$(date -v+3d +%F); D10=$(date -v+10d +%F); D20=$(date -v+20d +%F)
rm -f "$PAINEL_DATA_DIR"/materias/*.json "$PAINEL_DATA_DIR"/calendario.json* "$PAINEL_DATA_DIR"/historico.json "$PAINEL_DATA_DIR"/timer.json
cat > "$PAINEL_DATA_DIR/materias/PROG.json" <<EOF
{"sigla":"PROG","nome":"Otimização","atualizado_em":"$NOW_ISO","media_aprovacao":7,
 "notas":[{"item":"P1","peso":0.3,"nota":6,"max":10}],
 "avaliacoes":[
  {"id":"rec","tipo":"prova","titulo":"Recuperação final","data":"$D1","peso":null,"status":"pendente"},
  {"id":"ex","tipo":"prova","titulo":"EXAME","data":"$D1","peso":0.9,"status":"pendente"},
  {"id":"sc","tipo":"prova","titulo":"Segunda Chamada da P1","data":"$D1","peso":0.9,"status":"pendente"},
  {"id":"sub","tipo":"prova","titulo":"Prova substitutiva","data":"$D1","peso":0.9,"status":"pendente"},
  {"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.5,"status":"pendente","topicos":["a"]},
  {"id":"lista","tipo":"outro","titulo":"Lista","data":"$D3","peso":0.2,"status":"pendente","topicos":["b"]}],
 "topicos":[{"id":"a","nome":"Simplex","bloco":"P2","dificuldade":1,"status":"praticando","exercicios_feitos":10,"exercicios_certos":7,"horas_restantes":4},
            {"id":"b","nome":"Transporte","bloco":"P2","dificuldade":1,"status":"praticando","horas_restantes":1}],
 "simulados":[{"avaliacao":"p2","data":"$DM5","nota":2,"max":10,"minutos":90},{"avaliacao":"p2","data":"$DM1","nota":8,"max":10,"minutos":100},{"avaliacao":"outra","data":"$D0","nota":0,"max":10}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/GEST.json" <<EOF
{"sigla":"GEST","media_aprovacao":7,"avaliacoes":[
  {"id":"rec","tipo":"prova","titulo":"Recuperação do RA3","data":"$D1","peso":null,"status":"pendente"},
  {"id":"ta","tipo":"trabalho","titulo":"Trabalho A","data":"$D3","peso":0.3,"status":"pendente"},
  {"id":"tb","tipo":"trabalho","titulo":"Trabalho B","data":"$D10","peso":0.5,"status":"pendente"}],
 "topicos":[{"id":"x","nome":"X","bloco":"P2","status":"visto","horas_restantes":2}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/FIS.json" <<EOF
{"sigla":"FIS","media_aprovacao":7,"avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.4,"status":"pendente","topicos":["t"]}],
 "topicos":[{"id":"t","nome":"T","status":"visto","horas_restantes":3}],"nota_necessaria":{"valor":9}}
EOF
printf '[{"id":"s1","materia":"PROG","inicio":"%sT09:00:00-03:00","fim":"%sT10:00:00-03:00","minutos":60,"origem":"timer"},{"id":"s2","materia":"PROG","inicio":"%sT14:00:00-03:00","fim":"%sT15:00:00-03:00","minutos":60,"origem":"timer"},{"id":"s3","materia":"PROG","inicio":"%sT20:00:00-03:00","fim":"%sT21:00:00-03:00","minutos":60,"origem":"timer"},{"id":"s4","materia":"GEST","inicio":"%sT20:00:00-03:00","fim":"%sT21:00:00-03:00","minutos":60,"origem":"timer"}]' "$DM1" "$DM1" "$DM1" "$DM1" "$DM1" "$DM1" "$DM1" "$DM1" > "$PAINEL_DATA_DIR/sessoes.json"
printf '{"%s":{"PROG":{"alvo":"p2","horas_restantes":6,"min_estudados":0},"GEST":{"alvo":"ta","horas_restantes":5,"min_estudados":0}}}' "$DM3" > "$PAINEL_DATA_DIR/historico.json"
sobe
S=$(curl -s "$B/api/state")
check "contingentes nunca viram alvo: PROG mira P2" "$S" 's.materias.PROG.calc.alvo_estudo.id==="p2"'
check "contingentes não definem urgência e peso" "$S" '(f=>f.peso===0.5&&f.urgencia===0.308)(s.ranking.find(r=>r.sigla==="PROG").fatores)'
check "contingentes seguem na agenda" "$S" '["rec","ex","sc","sub"].every(id=>s.agenda.some(a=>a.materia==="PROG"&&a.id===id))'
check "sem prova pendente: alvo é a de maior valor (Trabalho A), não a recuperação" "$S" 's.materias.GEST.calc.alvo_estudo.id==="ta"'
check "simulado mais recente do alvo exposto" "$S" '(x=>x&&x.nota===8&&x.max===10&&x.data==="'"$DM1"'")(s.materias.PROG.calc.simulado)'
check "confiança = 0,6 x simulado + 0,4 x exercícios" "$S" 'Math.abs(s.materias.PROG.calc.confianca-0.68)<0.002'
check "sem simulado: calc.simulado null" "$S" 's.materias.GEST.calc.simulado===null && s.materias.FIS.calc.simulado===null'
check "nota projetada PROG = 0,3x6 + 0,5x6,8 + 0,2x5 = 6,2" "$S" 'Math.abs(s.materias.PROG.calc.nota_projetada-6.2)<0.01 && Math.abs(s.materias.PROG.calc.margem+0.8)<0.01'
check "risco é sigmoide da margem (-0,8 dá 0,707)" "$S" 'Math.abs(s.ranking.find(r=>r.sigla==="PROG").fatores.risco_nota-0.707)<0.002'
check "sigmoide: -2 dá 0,9 e +2 dá 0,1" "$S" '(k=>Math.abs(1/(1+Math.exp(-2*k))-0.9)<1e-9&&Math.abs(1/(1+Math.exp(2*k))-0.1)<1e-9)(Math.log(9)/2)'
check "pesos que não somam 1: projeção null com motivo" "$S" 's.materias.FIS.calc.nota_projetada===null && s.materias.FIS.calc.margem===null && /somam 40%/.test(s.materias.FIS.calc.nota_projetada_motivo)'
check "margem null mantém risco antigo (nota necessária 9)" "$S" 'Math.abs(s.ranking.find(r=>r.sigla==="FIS").fatores.risco_nota-0.667)<0.002'
check "score com os pesos novos" "$S" '(r=>{const f=r.fatores,c=s.materias[r.sigla].calc;let x=100*(0.30*f.urgencia+0.15*f.peso+0.15*f.lacuna+0.15*f.carga+0.25*f.risco_nota);if(c.folga_h!=null&&c.folga_h<0)x+=Math.min(10,-2*c.folga_h);return Math.abs(Math.min(100,x)-r.score)<0.3})(s.ranking.find(r=>r.sigla==="PROG"))'
check "resumo cita média projetada e margem" "$S" '/média projetada 6,2 \(margem -0,8\)/.test(s.ranking.find(r=>r.sigla==="PROG").resumo)'
check "ritmo medido: 2 h reduzidas, 3 h estudadas, fator 1,5" "$S" '(r=>r&&r.h_estimadas_reduzidas===2&&r.h_estudadas===3&&r.fator===1.5)(s.materias.PROG.calc.ritmo)'
check "horas calibradas = 4 x 1,5 = 6" "$S" 's.materias.PROG.calc.horas_restantes===4 && s.materias.PROG.calc.horas_restantes_calibradas===6'
check "folga usa as horas calibradas" "$S" '(c=>Math.abs(c.folga_h-(c.horas_disponiveis_ate_prova-6))<0.15)(s.materias.PROG.calc)'
check "menos de 3 sessões no timer: ritmo e calibradas null" "$S" 's.materias.GEST.calc.ritmo===null && s.materias.GEST.calc.horas_restantes_calibradas===null'
check "ganho por hora = peso x 10 x (1 - conf) / max(horas, 1)" "$S" '(c=>Math.abs(c.ganho_por_hora-0.5*10*(1-c.confianca)/6)<0.003)(s.materias.PROG.calc)'
check "ganho por hora null sem peso no alvo" "$S" 's.materias.CALC.calc.ganho_por_hora===null'
H=$(cat "$PAINEL_DATA_DIR/historico.json")
check "historico.json ganhou o snapshot de hoje" "$H" '(x=>x&&x.PROG.alvo==="p2"&&x.PROG.horas_restantes===4&&x.PROG.min_estudados===180)(s["'"$D0"'"])'
check "snapshot antigo preservado" "$H" 's["'"$DM3"'"].PROG.horas_restantes===6'
check "sem NaN no State" "$S" '!/NaN|undefined|Infinity/.test(JSON.stringify({...s,materias:Object.values(s.materias).map(m=>({...m,dados:null}))}))'

echo "== 12. desempate por ganho por hora"
desce
# rotina sem janela livre: a recomendação não segue bloco do plano e o desempate decide
echo '{"acorda":"05:30","dorme":"05:31","preparo_min":0,"dias":{}}' > "$PAINEL_DATA_DIR/rotina.json"
rm -f "$PAINEL_DATA_DIR"/materias/*.json "$PAINEL_DATA_DIR"/sessoes.json "$PAINEL_DATA_DIR"/historico.json
for par in "REDES 1" "ELET 2.5"; do
  set -- $par
  printf '{"sigla":"%s","avaliacoes":[{"id":"p","tipo":"prova","titulo":"Prova","data":"%s","peso":0.4,"status":"pendente","topicos":["t"]}],"topicos":[{"id":"t","nome":"T","status":"visto","horas_restantes":%s}]}' "$1" "$D20" "$2" > "$PAINEL_DATA_DIR/materias/$1.json"
done
sobe
S=$(curl -s "$B/api/state")
check "as duas estão a até 3 pontos" "$S" 'Math.abs(s.ranking[0].score-s.ranking[1].score)<=3'
check "recomendação vai para o maior ganho por hora (REDES)" "$S" 's.recomendacao.materia==="REDES" && s.materias.REDES.calc.ganho_por_hora>s.materias.ELET.calc.ganho_por_hora'
check "motivo cita o ganho por hora" "$S" '/cada hora aqui vale cerca de 3 pontos na média/.test(s.recomendacao.motivo)'

echo "== 13. composição da média final"
desce
rm -f "$PAINEL_DATA_DIR"/materias/*.json "$PAINEL_DATA_DIR"/sessoes.json "$PAINEL_DATA_DIR"/historico.json
cat > "$PAINEL_DATA_DIR/materias/ELET.json" <<EOF
{"sigla":"ELET","nota_necessaria":{"valor":null},
 "avaliacoes":[{"id":"p2","tipo":"prova","titulo":"Prova 2","data":"$D9","peso":0.4,"status":"pendente","topicos":["a"]},
   {"id":"tr","tipo":"trabalho","titulo":"Trabalho","data":"$D3","peso":0.1,"status":"pendente","topicos":[]},
   {"id":"ent","tipo":"trabalho","titulo":"Relatório","data":"$DM3","peso":0.1,"status":"entregue","topicos":["a"]}],
 "topicos":[{"id":"a","nome":"A","dificuldade":1,"status":"praticando","horas_restantes":3},{"id":"b","nome":"B","dificuldade":1,"status":"visto","horas_restantes":2}],
 "composicao":[{"item":"P1","avaliacao_id":null,"peso_final":0.3,"nota":6},{"item":"Lista 1","avaliacao_id":null,"peso_final":0.1,"nota":8},
   {"item":"Prova 2","avaliacao_id":"p2","peso_final":0.3,"nota":null},{"item":"Teste 2","avaliacao_id":null,"peso_final":0.1,"nota":null},
   {"item":"Trabalho","avaliacao_id":"tr","peso_final":0.1,"nota":null},{"item":"Relatório","avaliacao_id":"ent","peso_final":0.1,"nota":null}],
 "composicao_obs":"teste"}
EOF
cat > "$PAINEL_DATA_DIR/materias/CALC.json" <<EOF
{"sigla":"CALC","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.4,"status":"pendente","topicos":["a"]},
   {"id":"tr","tipo":"trabalho","titulo":"Trabalho","data":"$D3","peso":0.1,"status":"pendente"}],
 "topicos":[{"id":"a","nome":"A","dificuldade":1,"status":"praticando","horas_restantes":3}],
 "composicao":[{"item":"P1","avaliacao_id":null,"peso_final":0.5,"nota":4},{"item":"P2","avaliacao_id":"p2","peso_final":0.4,"nota":null},{"item":"Trabalho","avaliacao_id":"tr","peso_final":0.1,"nota":null}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/REDES.json" <<EOF
{"sigla":"REDES","nota_necessaria":{"valor":5},"avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.5,"status":"pendente","topicos":["a"]}],
 "topicos":[{"id":"a","nome":"A","status":"visto","horas_restantes":3}],
 "composicao":[{"item":"P1","avaliacao_id":null,"peso_final":0.5,"nota":9},{"item":"P2","avaliacao_id":"p2","peso_final":0.5,"nota":null}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/PROG.json" <<EOF
{"sigla":"PROG","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.5,"status":"pendente"}],
 "composicao":[{"item":"P1","peso_final":0.5,"nota":9},{"item":"P2","avaliacao_id":"p2","peso_final":0.3,"nota":null}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/GEST.json" <<EOF
{"sigla":"GEST","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.5,"status":"pendente"}],
 "composicao":[{"item":"P1","peso_final":0.5,"nota":9},{"item":"P2","avaliacao_id":"p2","peso_final":"x","nota":null}]}
EOF
sobe
S=$(curl -s "$B/api/state")
check "garantido = 0,3x6 + 0,1x8 = 2,6 e em jogo 0,6" "$S" 's.materias.ELET.calc.garantido===2.6 && s.materias.ELET.calc.em_jogo===0.6'
check "projeção: alvo 10xconf, prova pendente pela confiança geral, entregas pela média das entregas" "$S" 'Math.abs(s.materias.ELET.calc.nota_projetada-6.075)<0.006'
check "média ausente vira 7: margem = projeção - 7" "$S" 'Math.abs(s.materias.ELET.calc.margem-(s.materias.ELET.calc.nota_projetada-7))<0.011'
check "motivo explica a projeção das entregas pela média (8)" "$S" '/média das entregas já lançadas \(8\)/.test(s.materias.ELET.calc.nota_projetada_motivo)'
check "nota necessária no alvo calculada pelo painel (8,08)" "$S" 'Math.abs(s.materias.ELET.calc.nota_necessaria-8.08)<0.01 && s.materias.ELET.calc.nota_necessaria_origem==="painel"'
check "sem entrega lançada: entregas projetadas com 7 e motivo diz isso" "$S" '/projetadas com 7/.test(s.materias.CALC.calc.nota_projetada_motivo) && Math.abs(s.materias.CALC.calc.nota_projetada-(2+0.4*5+0.1*7))<0.01'
check "nota necessária CALC = (7 - 2 - 0,7) / 0,4 = 10,75 (pode passar de 10)" "$S" 's.materias.CALC.calc.nota_necessaria===10.75'
check "nota necessária da sessão tem prioridade" "$S" 's.materias.REDES.calc.nota_necessaria===5 && s.materias.REDES.calc.nota_necessaria_origem==="sessao" && s.materias.REDES.calc.garantido===4.5'
check "composição que soma 80% é ignorada com motivo" "$S" 's.materias.PROG.calc.nota_projetada===null && s.materias.PROG.calc.garantido===null && /composição soma 80%/.test(s.materias.PROG.calc.nota_projetada_motivo)'
check "composição com peso não numérico é ignorada" "$S" 's.materias.GEST.calc.garantido===null && /peso faltando/.test(s.materias.GEST.calc.nota_projetada_motivo)'
check "sem composição e sem nota: origem null" "$S" 's.materias.FIS.calc.nota_necessaria_origem===null && s.materias.FIS.calc.garantido===null'
check "risco usa a margem da composição" "$S" '(r=>Math.abs(r.fatores.risco_nota-1/(1+Math.exp(Math.log(9)/2*s.materias.ELET.calc.margem)))<0.002)(s.ranking.find(r=>r.sigla==="ELET"))'
check "sem NaN no State" "$S" '!/NaN|undefined|Infinity/.test(JSON.stringify({...s,materias:Object.values(s.materias).map(m=>({...m,dados:null}))}))'

echo "== 14. plano do dia com rotina, calendário e relógio fixo (segunda 16/11/2026)"
desce
rm -f "$PAINEL_DATA_DIR"/materias/*.json "$PAINEL_DATA_DIR"/sessoes.json "$PAINEL_DATA_DIR"/historico.json "$PAINEL_DATA_DIR"/timer.json
cat > "$PAINEL_DATA_DIR/rotina.json" <<'EOF'
{
  "acorda": "05:30", "dorme": "23:30", "preparo_min": 10, "descanso_chegada_min": 15,
  "bloco_min": 50, "pausa_min": 10, "bloco_minimo_min": 25,
  "dias": {
    "seg": [{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"17:00","ate":"23:00","titulo":"Faculdade"}],
    "ter": [{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"17:00","ate":"23:00","titulo":"Faculdade"}],
    "qua": [{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"16:00","ate":"23:00","titulo":"Faculdade"}],
    "qui": [{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"16:00","ate":"20:10","titulo":"Faculdade"},{"de":"20:10","ate":"20:50","titulo":"Jantar"}],
    "sex": [{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"19:30","ate":"20:10","titulo":"Jantar"}],
    "sab": [{"de":"12:00","ate":"13:00","titulo":"Almoço"},{"de":"19:30","ate":"20:10","titulo":"Jantar"}],
    "dom": [{"de":"12:00","ate":"13:00","titulo":"Almoço"},{"de":"19:30","ate":"20:10","titulo":"Jantar"}]
  }
}
EOF
cp "$PAINEL_DATA_DIR/rotina.json" "$PAINEL_DATA_DIR/rotina14.json"
cat > "$PAINEL_DATA_DIR/calendario.json" <<'EOF'
{"ok":true,"erro":null,"sincronizado_em":"2026-11-16T04:00:00-03:00","eventos":[
 {"titulo":"Aula CALC","inicio":"2026-11-16T18:15:00-03:00","fim":"2026-11-16T19:45:00-03:00","dia_inteiro":false,"calendario":"Faculdade"},
 {"titulo":"Dentista","inicio":"2026-11-16T16:00:00-03:00","fim":"2026-11-16T16:30:00-03:00","dia_inteiro":false,"calendario":"Pessoal"},
 {"titulo":"Feriado da Consciência Negra","inicio":"2026-11-20T00:00:00-03:00","fim":"2026-11-20T23:59:59-03:00","dia_inteiro":true,"calendario":"Feriados"},
 {"titulo":"Aniversário","inicio":"2026-11-17T00:00:00-03:00","fim":"2026-11-17T23:59:59-03:00","dia_inteiro":true,"calendario":"Pessoal"}
]}
EOF
echo '["GEST"]' > "$PAINEL_DATA_DIR/por_ultimo.json"
cat > "$PAINEL_DATA_DIR/materias/CALC.json" <<'EOF'
{"sigla":"CALC","atualizado_em":"2026-11-16T04:00:00-03:00","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"2026-11-18","hora":"19:00","peso":0.4,"status":"pendente","topicos":["t1","t2"]}],
 "topicos":[{"id":"t1","nome":"Difícil","dificuldade":5,"status":"visto","horas_restantes":3},{"id":"t2","nome":"Fácil","dificuldade":1,"status":"nao_visto","horas_restantes":2}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/PROG.json" <<'EOF'
{"sigla":"PROG","atualizado_em":"2026-11-16T04:00:00-03:00","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"2026-11-21","peso":0.1,"status":"pendente","topicos":["o1"]}],
 "topicos":[{"id":"o1","nome":"Simplex","dificuldade":3,"status":"praticando","horas_restantes":4}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/GEST.json" <<'EOF'
{"sigla":"GEST","atualizado_em":"2026-11-16T04:00:00-03:00","avaliacoes":[{"id":"p","tipo":"prova","titulo":"Prova","data":"2026-11-30","peso":0.5,"status":"pendente","topicos":["g1"]}],
 "topicos":[{"id":"g1","nome":"G","dificuldade":2,"status":"nao_visto","horas_restantes":20}]}
EOF
PAINEL_AGORA="2026-11-16T05:00:00-03:00" sobe
S=$(curl -s "$B/api/state")
echo "$S" > "$PAINEL_DATA_DIR/plano14.json"
check "plano com 7 dias, hoje primeiro, rotina_ok" "$S" 's.plano.rotina_ok===true && s.plano.dias.length===7 && s.plano.dias[0].data==="2026-11-16" && s.plano.dias[0].dia_semana==="seg" && s.plano.dias[6].data==="2026-11-22"'
check "segunda: blocos 05:40-06:30, 06:40-07:15 e 16:30-17:00 (115 min)" "$S" '(d=>d.estudo_min===115&&d.itens.filter(i=>i.tipo==="estudo").map(i=>i.inicio.slice(11,16)+"-"+i.fim.slice(11,16)).join()==="05:40-06:30,06:40-07:15,16:30-17:00")(s.plano.dias[0])'
check "segunda: ocupados da rotina e do calendário, aula dentro da Faculdade absorvida" "$S" '(it=>it.some(i=>i.titulo==="Estágio"&&i.origem==="rotina")&&it.some(i=>i.titulo==="Dentista"&&i.origem==="calendario")&&it.some(i=>i.titulo==="Faculdade")&&!it.some(i=>i.titulo==="Aula CALC"))(s.plano.dias[0].itens)'
check "itens em ordem de horário" "$S" 's.plano.dias.every(d=>d.itens.every((i,k,a)=>k===0||a[k-1].inicio<=i.inicio))'
check "dia inteiro sem feriado no título não ocupa (terça com estágio normal)" "$S" 's.plano.dias[1].itens.some(i=>i.titulo==="Estágio") && !s.plano.dias[1].itens.some(i=>i.titulo==="Aniversário")'
check "feriado de dia inteiro tira estágio da sexta" "$S" '(d=>!d.itens.some(i=>i.titulo==="Estágio")&&d.estudo_min>600)(s.plano.dias[4])'
check "sábado limitado pelo teto do fim de semana" "$S" 's.plano.dias[5].estudo_min<=s.config.horas_dia_fds*60 && s.plano.dias[5].estudo_min>0'
check "livre_h do calendário = estudo_min / 60" "$S" 's.plano.dias.every((d,i)=>Math.abs(s.calendario.por_dia[i].livre_h-d.estudo_min/60)<0.051)'
check "primeiro bloco da manhã: CALC no tópico mais difícil" "$S" '(b=>b.materia==="CALC"&&b.topico.id==="t1"&&b.origem==="sugestao"&&b.titulo==="CALC: Difícil")(s.plano.dias[0].itens.find(i=>i.tipo==="estudo"))'
check "no máximo 2 blocos seguidos da mesma matéria, salvo crítico" "$S" 's.plano.dias.every(d=>{const e=d.itens.filter(i=>i.tipo==="estudo");return e.every((x,k)=>!x.materia||x.critico||k<2||!(e[k-1].materia===x.materia&&e[k-2].materia===x.materia))})'
check "véspera da P2 (terça): CALC em pelo menos metade dos blocos" "$S" '(e=>e.filter(i=>i.materia==="CALC").length>=Math.ceil(e.length/2))(s.plano.dias[1].itens.filter(i=>i.tipo==="estudo"))'
check "dia da prova: CALC só antes das 19:00; depois, nunca" "$S" 's.plano.dias.every(d=>d.itens.filter(i=>i.materia==="CALC").every(i=>i.fim<="2026-11-18T19:00:01"))'
check "PROG sem hora: não estuda no dia da prova nem depois" "$S" 's.plano.dias.every(d=>d.data<"2026-11-21"||!d.itens.some(i=>i.materia==="PROG"))'
check "necessidade consumida: CALC não passa de 5 h mais um bloco" "$S" 's.plano.dias.flatMap(d=>d.itens).filter(i=>i.materia==="CALC").reduce((a,i)=>a+(new Date(i.fim)-new Date(i.inicio))/60000,0)<=5*60+50'
check "tópico avança: Fácil (2 h) não passa de 2 h mais um bloco e os dois aparecem" "$S" '(it=>it.some(i=>i.topico.id==="t1")&&it.some(i=>i.topico.id==="t2")&&it.filter(i=>i.topico.id==="t2").slice(0,-1).reduce((a,i)=>a+(new Date(i.fim)-new Date(i.inicio))/60000,0)<120)(s.plano.dias.flatMap(d=>d.itens).filter(i=>i.materia==="CALC"))'
check "por último (GEST): no máximo 1 bloco por dia e só quando sobra" "$S" 's.plano.dias.every(d=>d.itens.filter(i=>i.materia==="GEST").length<=1)'
check "sem necessidade: bloco Livre com matéria null" "$S" 's.plano.dias.flatMap(d=>d.itens).filter(i=>i.tipo==="estudo"&&i.materia===null).every(i=>i.titulo==="Livre"&&i.topico===null)'
check "às 05:00 o bloco está a 40 min: recomendação normal" "$S" '!/Bloco do plano/.test(s.recomendacao.motivo)'
echo '{"acorda":"06:00","dorme":"23:30","preparo_min":10,"dias":{"seg":[{"de":"07:15","ate":"15:25","titulo":"Estágio"}]}}' > "$PAINEL_DATA_DIR/rotina.json"
sleep 0.3
S=$(curl -s "$B/api/state")
check "rotina.json editado é recarregado (primeiro bloco 06:10)" "$S" 's.plano.dias[0].itens.find(i=>i.tipo==="estudo").inicio.slice(11,16)==="06:10"'
cp "$PAINEL_DATA_DIR/plano14.json" /dev/null
desce
cat > "$PAINEL_DATA_DIR/rotina.json" <<'EOF'
{"acorda":"05:30","dorme":"23:30","preparo_min":10,"descanso_chegada_min":15,"bloco_min":50,"pausa_min":10,"bloco_minimo_min":25,
 "dias":{"seg":[{"de":"07:15","ate":"15:25","titulo":"Estágio"},{"de":"17:00","ate":"23:00","titulo":"Faculdade"}]}}
EOF
PAINEL_AGORA="2026-11-16T05:35:00-03:00" sobe
S=$(curl -s "$B/api/state")
check "bloco começando em até 10 min: recomendação segue a fila" "$S" '(r=>r.materia==="CALC"&&r.frente==="estudo"&&r.topico&&r.topico.id==="t1"&&r.bloco_sugerido_min===55&&r.janela.rotulo==="hoje, 05:40 às 07:15"&&/^Próxima janela: hoje, 05:40 às 07:15 \(85 min\)\. Primeiro, CALC: Difícil \(50 min\)/.test(r.motivo))(s.recomendacao)'
desce
PAINEL_AGORA="2026-11-16T10:00:00-03:00" sobe
S=$(curl -s "$B/api/state")
check "dentro do estágio: motivo diz o próximo bloco livre" "$S" '/Agora é Estágio; próximo bloco livre às 16:30\./.test(s.recomendacao.motivo)'
check "hoje lista só o que termina depois de agora" "$S" 's.plano.dias[0].itens.every(i=>i.fim>"2026-11-16T10:00")'
desce
PAINEL_AGORA="2026-11-16T23:20:00-03:00" sobe
S=$(curl -s "$B/api/state")
check "fim do dia: sem bloco hoje, próximo bloco amanhã" "$S" 's.plano.dias[0].estudo_min===0'
desce
rm -f "$PAINEL_DATA_DIR/por_ultimo.json"
sobe

echo "== 15. ping das sessões, timer automático e tempo por tópico"
mins() { date -v"$1"M +%Y-%m-%dT%H:%M:%S-03:00; }
R=$(post /api/timer/ping '{"materia":"CALC","topico_id":"t1","origem":"sessao"}')
check "ping sem timer abre timer da sessão" "$R" 's.ok===true && s.timer.origem==="sessao" && s.timer.topico_id==="t1" && s.timer.materia==="CALC" && typeof s.timer.ultimo_ping==="string" && s.topico_min_total>=0'
INI1=$($NODE -e 'console.log(JSON.parse(process.argv[1]).timer.inicio)' "$R")
R=$(post /api/timer/ping '{"materia":"CALC","topico_id":"t1","origem":"sessao"}')
check "ping no mesmo tópico só atualiza o ultimo_ping" "$R" 's.timer.inicio==="'"$INI1"'" && !s.ignorado'
S=$(curl -s "$B/api/state")
check "State.timer tem origem e ultimo_ping" "$S" 's.timer.origem==="sessao" && typeof s.timer.ultimo_ping==="string" && s.timer.topico_id==="t1"'
[ "$(code -X POST -d '{"materia":"XX"}' "$B/api/timer/ping")" = "400" ] && ok "ping com matéria inválida dá 400" || bad "ping inválido"
desce
printf '{"materia":"CALC","topico":"t1","topico_id":"t1","inicio":"%s","origem":"sessao","ultimo_ping":"%s"}' "$(mins -10)" "$(mins -1)" > "$PAINEL_DATA_DIR/timer.json"
sobe
R=$(post /api/timer/ping '{"materia":"CALC","topico":"FÁCIL","origem":"sessao"}')
check "tópico pelo nome (sem acento e maiúscula) troca o trecho" "$R" 's.timer.topico_id==="t2" && s.timer.origem==="sessao" && s.topico_min_total<1'
S=$(curl -s "$B/api/state")
check "trecho anterior salvo com topico_id e fonte sessao" "$S" '(x=>x&&Math.round(x.minutos)===10&&x.topico==="t1")(s.estudo.sessoes_recentes.find(r=>r.materia==="CALC"))'
G=$(curl -s "$B/api/materia/CALC")
check "tempo por tópico no GET da matéria e no State" "$G" 'Math.round(s.tempo_por_topico.t1)===10 && Math.round(s.calc.tempo_por_topico.t1)===10'
R=$(post /api/timer/ping '{"materia":"CALC","topico_id":"t1","origem":"sessao"}')
check "topico_min_total soma as sessões do tópico" "$R" 'Math.round(s.topico_min_total)===10'
desce
printf '{"materia":"PROG","topico":null,"inicio":"%s","origem":"sessao","ultimo_ping":"%s"}' "$(mins -40)" "$(mins -20)" > "$PAINEL_DATA_DIR/timer.json"
sobe
S=$(curl -s "$B/api/state")
check "sessão sem ping há 20 min fecha sozinha ao subir (fim = último ping + 2 min)" "$S" 's.timer===null && (x=>x&&Math.round(x.minutos)===22)(s.estudo.sessoes_recentes.find(r=>r.materia==="PROG"))'
check "minutos sem tópico identificado" "$S" 's.materias.PROG.estudo.sem_topico_min>=22'
desce
printf '{"materia":"PROG","topico":null,"inicio":"%s","origem":"painel","ultimo_ping":null}' "$(mins -60)" > "$PAINEL_DATA_DIR/timer.json"
sobe
S=$(curl -s "$B/api/state")
check "timer do painel sem ping continua manual" "$S" 's.timer&&s.timer.materia==="PROG"&&s.timer.origem==="painel"'
desce
printf '{"materia":"CALC","topico":null,"inicio":"%s","origem":"painel","ultimo_ping":"%s"}' "$(mins -30)" "$(mins -15)" > "$PAINEL_DATA_DIR/timer.json"
sobe
S=$(curl -s "$B/api/state")
check "timer do painel que já recebeu ping fecha sozinho" "$S" 's.timer===null && s.estudo.sessoes_recentes.some(r=>r.materia==="CALC"&&Math.round(r.minutos)===17)'
S=$(post /api/timer/start '{"materia":"CALC"}')
check "start grava origem painel" "$S" 's.timer.origem==="painel" && s.timer.ultimo_ping===null'
R=$(post /api/timer/ping '{"materia":"PROG","origem":"sessao"}')
check "ping de outra matéria com timer do painel recente é ignorado" "$R" 's.ignorado===true && s.timer.materia==="CALC"'
R=$(post /api/timer/ping '{"materia":"CALC","topico_id":"t1","origem":"sessao"}')
check "ping na mesma matéria do painel só põe tópico e ultimo_ping" "$R" 's.timer.origem==="painel" && s.timer.topico_id==="t1" && typeof s.timer.ultimo_ping==="string"'
post /api/timer/cancel '' >/dev/null
desce
printf '{"materia":"CALC","topico":null,"inicio":"%s","origem":"painel","ultimo_ping":null}' "$(mins -10)" > "$PAINEL_DATA_DIR/timer.json"
sobe
R=$(post /api/timer/ping '{"materia":"PROG","origem":"sessao"}')
check "ping de outra matéria com painel antigo fecha e abre timer da sessão" "$R" 's.timer.materia==="PROG" && s.timer.origem==="sessao" && !s.ignorado'
S=$(curl -s "$B/api/state")
check "trecho do painel salvo (10 min)" "$S" 's.estudo.sessoes_recentes.some(r=>r.materia==="CALC"&&Math.round(r.minutos)===10)'
post /api/timer/cancel '' >/dev/null
cat > "$PAINEL_DATA_DIR/pe.json" <<EOF
{"sigla":"ELET","atualizado_em":"$NOW_ISO","avaliacoes":[{"id":"p2","tipo":"prova","titulo":"P2","data":"$D9","peso":0.4,"status":"pendente","topicos":["a","b","c"]}],
 "topicos":[{"id":"a","nome":"Árvores","status":"dominado","horas_restantes":0,"horas_estimadas_inicial":2},
   {"id":"b","nome":"Grafos","status":"visto","horas_restantes":0,"horas_estimadas_inicial":2},
   {"id":"c","nome":"Heaps","status":"visto","horas_restantes":99,"horas_teoria_restantes":1,"horas_pratica_restantes":2,"horas_estimadas_inicial":4}]}
EOF
post /api/materia/ELET "$(cat "$PAINEL_DATA_DIR/pe.json")" >/dev/null
S=$(curl -s "$B/api/state")
check "teoria + prática substituem horas_restantes (3, não 99)" "$S" 's.materias.ELET.calc.horas_restantes===3'
check "sem tempo nos tópicos: ritmo null" "$S" 's.materias.ELET.calc.ritmo===null'
post /api/sessao '{"materia":"ELET","minutos":60,"topico_id":"a"}' >/dev/null
S=$(post /api/sessao '{"materia":"ELET","minutos":60,"topico":"grafos"}')
check "sessão manual casa tópico pelo nome" "$S" 'Math.round(s.materias.ELET.calc.tempo_por_topico.b)===60'
check "ritmo pelos tópicos: 120 min reais / 240 estimados = 0,5" "$S" '(r=>r&&r.metodo==="topicos"&&r.fator===0.5&&r.h_estudadas===2&&r.h_estimadas_reduzidas===4)(s.materias.ELET.calc.ritmo)'
check "horas calibradas caem em tempo real (3 x 0,5)" "$S" 's.materias.ELET.calc.horas_restantes_calibradas===1.5'
check "ritmo por histórico marca metodo" "$S" 'Object.values(s.materias).every(m=>!m.calc.ritmo||["topicos","historico"].includes(m.calc.ritmo.metodo))'

echo "== 16. agendador de frentes: caso real de semana de provas (segunda, 23:10)"
desce
rm -f "$PAINEL_DATA_DIR"/materias/*.json "$PAINEL_DATA_DIR"/sessoes.json "$PAINEL_DATA_DIR"/historico.json "$PAINEL_DATA_DIR"/timer.json "$PAINEL_DATA_DIR"/por_ultimo.json "$PAINEL_DATA_DIR"/config.json
cp "$PAINEL_DATA_DIR/rotina14.json" "$PAINEL_DATA_DIR/rotina.json"
cat > "$PAINEL_DATA_DIR/calendario.json" <<'EOF'
{"ok":true,"erro":null,"sincronizado_em":"2026-11-16T23:00:00-03:00","eventos":[
 {"titulo":"CALC","inicio":"2026-11-17T18:15:00-03:00","fim":"2026-11-17T19:45:00-03:00","dia_inteiro":false,"calendario":"Faculdade"},
 {"titulo":"FIS","inicio":"2026-11-17T19:45:00-03:00","fim":"2026-11-17T21:30:00-03:00","dia_inteiro":false,"calendario":"Faculdade"},
 {"titulo":"FISX revisão","inicio":"2026-11-17T08:00:00-03:00","fim":"2026-11-17T08:30:00-03:00","dia_inteiro":false,"calendario":"Estágio"}
]}
EOF
cat > "$PAINEL_DATA_DIR/materias/CALC.json" <<'EOF'
{"sigla":"CALC","atualizado_em":"2026-11-16T23:00:00-03:00","avaliacoes":[
  {"id":"lab05","tipo":"apresentacao","titulo":"LAB05 fim: apresentar os vistos","data":"2026-11-17","hora":"18:15","peso":0.073,"status":"em_andamento",
   "preparo":{"horas_restantes":1.5,"o_que":"Montar os 8 vistos no Quartus","checklist":[{"item":"visto 1","feito":true},{"item":"visto 2","feito":false}]}},
  {"id":"s3","tipo":"trabalho","titulo":"Lista S3","data":"2026-11-18","hora":"18:15","peso":0.017,"status":"pendente","topicos":[]},
  {"id":"s4","tipo":"prova","titulo":"Prova S4","data":"2026-11-25","hora":"18:15","peso":0.117,"status":"pendente","topicos":["x"]}],
 "topicos":[{"id":"x","nome":"Somadores","dificuldade":3,"status":"nao_visto","horas_restantes":1}]}
EOF
cat > "$PAINEL_DATA_DIR/materias/FIS.json" <<'EOF'
{"sigla":"FIS","atualizado_em":"2026-11-16T23:00:00-03:00","avaliacoes":[
  {"id":"lab11","tipo":"trabalho","titulo":"Entrega LAB11","data":"2026-11-17","hora":"21:30","peso":null,"status":"pendente","topicos":[]},
  {"id":"p2","tipo":"prova","titulo":"P2","data":"2026-11-24","peso":0.4,"status":"pendente","topicos":["p"]}],
 "topicos":[{"id":"p","nome":"Trifásico","dificuldade":3,"status":"praticando","horas_restantes":4}]}
EOF
PAINEL_AGORA="2026-11-16T23:10:00-03:00" sobe
S=$(post /api/config '{"dorme_hoje":"02:00"}')
echo "$S" > "$PAINEL_DATA_DIR/caso.json"
check "dorme_hoje exposto e válido até o próximo despertar" "$S" 's.config.dorme_hoje==="02:00" && s.config.ajuste_valido_ate.startsWith("2026-11-17T05:30")'
check "plano de hoje estica até 02:00" "$S" 's.plano.dias[0].itens.filter(i=>i.tipo==="estudo").map(i=>i.inicio.slice(11,16)).join()==="23:15,00:15,01:15,01:30"'
check "frentes: preparo do LAB05 (1,5 h) cabe, prazo 18:15" "$S" '(f=>f&&f.horas===1.5&&f.cabe===true&&f.prazo.startsWith("2026-11-17T18:15")&&f.o_que==="Montar os 8 vistos no Quartus"&&!!f.inicio_mais_tarde)(s.frentes.find(f=>f.id==="preparo:CALC:lab05"))'
check "triagem de FIS: aula amanhã 19:45 e entrega sem preparo" "$S" '(f=>f&&f.horas===0.25&&f.prazo.startsWith("2026-11-17T19:45"))(s.frentes.find(f=>f.id==="triagem:FIS"))'
check "CALC não tem triagem (preparo informado e dados novos)" "$S" '!s.frentes.some(f=>f.id==="triagem:CALC")'
check "proxima_aula por matéria (sigla como palavra)" "$S" 's.materias.FIS.calc.proxima_aula.inicio.startsWith("2026-11-17T19:45") && s.materias.CALC.calc.proxima_aula.inicio.startsWith("2026-11-17T18:15") && s.materias.PROG.calc.proxima_aula===null'
check "fila: preparo do LAB05 primeiro" "$S" '(f=>f[0].frente==="preparo"&&f[0].materia==="CALC"&&f[0].titulo==="Preparar LAB05 fim"&&f[0].avaliacao.id==="lab05")(s.recomendacao.fila)'
check "fila: estudo de CALC depois do preparo" "$S" '(f=>{const a=f.findIndex(x=>x.frente==="preparo"),b=f.findIndex(x=>x.frente==="estudo"&&x.materia==="CALC");return a===0&&b>a})(s.recomendacao.fila)'
check "fila: triagem de FIS na mesma noite, 15 min" "$S" '(x=>x&&x.minutos===15&&/^Ver o que precisa para a aula de FIS \(amanhã, 19:45\)$/.test(x.titulo))(s.recomendacao.fila.find(f=>f.frente==="triagem"))'
check "triagem de FIS acontece antes da aula" "$S" 's.plano.dias.flatMap(d=>d.itens).some(i=>i.frente==="triagem"&&i.materia==="FIS"&&i.fim<="2026-11-17T19:45:00.000-03:00")'
check "janela: hoje, 23:15 às 02:00" "$S" '(j=>j.rotulo==="hoje, 23:15 às 02:00"&&j.minutos===145)(s.recomendacao.janela)'
check "recomendação: frente preparo, LAB05, motivo explica a ordem" "$S" '(r=>r.materia==="CALC"&&r.frente==="preparo"&&r.avaliacao.id==="lab05"&&r.topico===null&&/^Próxima janela: hoje, 23:15 às 02:00 \(145 min\)\. Primeiro, Preparar LAB05 fim \(50 min\): LAB05 fim é amanhã às 18:15 e faltam 90 min de preparo\./.test(r.motivo)&&/Ver o que precisa para a aula de FIS/.test(r.motivo))(s.recomendacao)'
check "itens do plano têm frente, avaliação e crítico" "$S" 's.plano.dias.every(d=>d.itens.every(i=>"frente" in i&&"avaliacao" in i&&typeof i.critico==="boolean"))'
check "preparo vem antes do estudo de CALC (prazo em menos de 36 h)" "$S" '(it=>it.findIndex(i=>i.frente==="preparo")<it.findIndex(i=>i.frente==="estudo"&&i.materia==="CALC"))(s.plano.dias.flatMap(d=>d.itens))'
check "nada cabe fora do prazo: sem alerta de falta de tempo" "$S" '!s.alertas.some(a=>/de tempo livre/.test(a.texto))'
S=$(post /api/config '{"rotina":{"acorda":"06:00"}}')
check "rotina parcial no config muda acorda permanente" "$S" 's.config.rotina.acorda==="06:00" && s.config.rotina.dorme==="23:30"'
[ "$(code -X POST -d '{"dorme_hoje":"25:99"}' "$B/api/config")" = "400" ] && ok "dorme_hoje inválido dá 400" || bad "dorme_hoje inválido"
[ "$(code -X POST -d '{"rotina":{"acorda":"23:50"}}' "$B/api/config")" = "400" ] && ok "rotina com acorda depois de dorme dá 400" || bad "rotina inválida"
cat > "$PAINEL_DATA_DIR/materias/PROG.json" <<'EOF'
{"sigla":"PROG","atualizado_em":"2026-11-16T23:00:00-03:00","avaliacoes":[
  {"id":"tde","tipo":"tde","titulo":"TDE 2","data":"2026-11-17","peso":0.3,"status":"pendente","preparo":{"horas_restantes":10,"o_que":"Programa Simplex"}}]}
EOF
sleep 0.3
S=$(curl -s "$B/api/state")
check "preparo sem hora vence no primeiro compromisso do dia (07:15)" "$S" 's.frentes.find(f=>f.id==="preparo:PROG:tde").prazo.startsWith("2026-11-17T07:15")'
check "frente que não cabe: cabe false e faltam_min" "$S" '(f=>f.cabe===false&&f.faltam_min>0)(s.frentes.find(f=>f.id==="preparo:PROG:tde"))'
check "alerta crítico de falta de tempo" "$S" 's.alertas.some(a=>a.nivel==="critico"&&a.materia==="PROG"&&/^Faltam \d+ min de tempo livre para preparar TDE 2 até amanhã às 07:15\.$/.test(a.texto))'
check "frente que não cabe vira crítica desde já" "$S" 's.recomendacao.fila[0].materia==="PROG" && s.recomendacao.fila[0].critico===true'
desce
PAINEL_AGORA="2026-11-17T06:00:00-03:00" sobe
S=$(curl -s "$B/api/state")
check "ajuste de hoje expira no despertar seguinte" "$S" 's.config.dorme_hoje===null && s.config.ajuste_valido_ate===null'
desce
sobe

echo
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ "$FAIL" -eq 0 ]
