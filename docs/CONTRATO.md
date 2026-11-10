# Painel de Estudos: contrato

Painel local, ao vivo, para decidir o que estudar agora entre as disciplinas do semestre:
as siglas vêm de `data/disciplinas.json`. Porta **4747**. Node puro, **zero dependências**, sem build.

```
painel-estudos/
  server.js          servidor HTTP + SSE + motor de prioridade (backend)
  public/index.html  tela única, tudo inline (frontend)
  data/materias/<SIGLA>.json   dado enviado por cada sessão de matéria
  data/sessoes.json            sessões de estudo cronometradas
  data/timer.json              timer ativo (sobrevive a restart)
  data/config.json             teto de horas de estudo por dia
  data/calendario.json         cache da última leitura do Calendário (só leitura, a cada 5 min)
  data/historico.json          snapshot diário por matéria (horas restantes do alvo, minutos estudados)
  data/rotina.json             rotina semanal do usuário (editável, recarregada quando muda)
  data/por_ultimo.json         siglas que vão para o fim do ranking e ficam fora da recomendação
  calendario/ler-calendario    binário Swift (EventKit) que lê os próximos 21 dias
```

Regras gerais: português brasileiro em tudo que aparece na tela. **Proibido travessão longo** em
qualquer texto ou código. Fuso America/Sao_Paulo (-03:00). Nunca inventar dado: campo `null` aparece
como "sem dado", nunca como zero.

## 1. Dado de entrada por matéria (enviado pelas sessões)

`POST /api/materia/:sigla` com este JSON (qualquer campo pode vir `null` ou faltando, o servidor
tem que tolerar):

```json
{
  "sigla": "CALC", "nome": "...", "professor": null, "atualizado_em": "ISO",
  "formula_nota": "texto", "media_aprovacao": 7.0,
  "notas": [{ "item": "P1", "peso": 0.4, "nota": 6.5, "max": 10, "data": "2026-09-30" }],
  "nota_necessaria": { "valor": 7.5, "em": "P2", "explicacao": "..." },
  "avaliacoes": [{ "id": "p2", "tipo": "prova|tde|trabalho|apresentacao|outro", "titulo": "Prova 2",
    "data": "YYYY-MM-DD", "hora": "HH:MM|null", "peso": 0.4,
    "status": "pendente|em_andamento|entregue|feito", "topicos": ["id"], "confirmada": true, "fonte": "...",
    "preparo": { "horas_restantes": 1.5, "o_que": "o que falta preparar", "checklist": [{ "item": "...", "feito": false }] } }],
  "topicos": [{ "id": "slug", "nome": "...", "bloco": "P1|P2", "dificuldade": 1,
    "status": "nao_visto|visto|praticando|dominado", "exercicios_feitos": 0, "exercicios_certos": 0,
    "exercicios_disponiveis": null, "horas_restantes": 2.5, "ultima_pratica": "YYYY-MM-DD|null",
    "horas_teoria_restantes": 1, "horas_pratica_restantes": 1.5, "horas_estimadas_inicial": 4 }],
  "dificuldade_p2": 3, "horas_restantes_total": 12,
  "particularidades": "texto", "riscos": ["..."], "proximo_passo": "texto",
  "log": [{ "quando": "ISO", "o_que": "..." }],
  "simulados": [{ "avaliacao": "p2", "data": "YYYY-MM-DD", "nota": 6, "max": 10, "minutos": 90 }],
  "composicao": [{ "item": "P1", "avaliacao_id": "p1|null", "peso_final": 0.3, "nota": 6.5 }],
  "composicao_obs": "texto: como a média final é montada"
}
```

`preparo` (opcional por avaliação): trabalho de preparo com prazo (apresentação, entrega, relatório).
Tópicos: quando `horas_teoria_restantes` e `horas_pratica_restantes` vêm juntos, `horas_restantes` do
tópico vira a soma deles. `horas_estimadas_inicial` é a estimativa original, usada para medir o ritmo.

`composicao`: todos os itens que formam a média final, com `peso_final` efetivo (0..1, soma 1.0)
e `nota` de 0 a 10 quando já lançada (`null` se pendente). `media_aprovacao` ausente vale 7.

## 2. API

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/` | | `public/index.html` |
| GET | `/api/state` | | objeto `State` (seção 3) |
| GET | `/api/events` | | SSE. Evento `state` com o `State` inteiro em JSON a cada mudança, e um a cada 30 s (o ranking depende da hora). Comentário `: ping` a cada 15 s |
| POST | `/api/materia/:sigla` | JSON da seção 1 | `{ok:true}`. Grava em `data/materias/`, guarda `recebido_em` |
| GET | `/api/materia/:sigla` | | dado da matéria + `calc`, `estudo` e `tempo_por_topico` dela |
| POST | `/api/timer/start` | `{materia, topico?, topico_id?}` | `State`. Timer de origem `painel`. Se já houver timer ativo, encerra o anterior e salva |
| POST | `/api/timer/ping` | `{materia, topico_id?, topico?, origem: "sessao"}` | `{ok, ignorado?, timer, topico_min_total}`. Batimento da sessão de matéria (seção 4, Timer automático) |
| POST | `/api/timer/stop` | `{foco?: 1..5, nota?: string}` | `State`. Vira uma sessão. Descarta se durar menos de 60 s |
| POST | `/api/timer/cancel` | | `State`. Descarta sem salvar |
| POST | `/api/sessao` | `{materia, minutos, inicio?: ISO, topico?, topico_id?, foco?}` | `State`. Lançamento manual |
| DELETE | `/api/sessao/:id` | | `State` |
| POST | `/api/config` | `{horas_dia_semana?, horas_dia_fds?, dorme_hoje?: "HH:MM", acorda_amanha?: "HH:MM", rotina?: {acorda?, dorme?}}` | `State`. `dorme_hoje` e `acorda_amanha` valem só até o próximo despertar (`null` apaga); `rotina` muda `acorda`/`dorme` permanentes em `data/rotina.json` |
| POST | `/api/tarefa` | `{titulo, materia?: sigla, data?: "YYYY-MM-DD"}` | `State`. Tarefa livre do usuário; sem `data` fica "no radar" |
| POST | `/api/tarefa/:id` | `{feito?: bool, data?: "YYYY-MM-DD" \| null, titulo?, materia?}` | `State` |
| DELETE | `/api/tarefa/:id` | | `State` |
| POST | `/api/marca` | `{materia, id, estado: "pronto" \| "entregue" \| null}` | `State`. Marca feita no painel sobre uma avaliação: `pronto` zera o preparo (só falta entregar), `entregue` tira das listas, `null` desfaz. Fica em `data/marcas.json` e vale mesmo que o dado da matéria continue dizendo pendente |

Disciplinas: `data/disciplinas.json` (`[{"sigla": "CALC", "cor": "#2563d9"}]`) ou a variável `PAINEL_DISCIPLINAS="CALC,FIS"`. O `State` traz `disciplinas` e `tarefas` (pendentes e as concluídas hoje).

CORS liberado. Toda escrita em disco é atômica (arquivo temporário + rename).

## 3. Objeto State (o que o frontend consome)

```js
{
  agora: "ISO",
  config: { horas_dia_semana: 3, horas_dia_fds: 6,       // teto de estudo por dia (fds corta o plano)
            dorme_hoje: "HH:MM" | null, acorda_amanha: "HH:MM" | null, ajuste_valido_ate: "ISO" | null,
            rotina: { acorda: "HH:MM", dorme: "HH:MM" } },
  timer: null | { materia, topico, topico_id, inicio: "ISO", origem: "painel|sessao", ultimo_ping: "ISO" | null },
  recomendacao: {            // o que estudar AGORA
    materia: "CALC" | null,
    topico: { id, nome } | null,
    motivo: "frase curta em português explicando o porquê, com números",
    proximo_passo: "texto vindo da matéria ou null",
    bloco_sugerido_min: 50,
    alternativa: { materia, motivo } | null,
    frente: "estudo|preparo|triagem" | null,
    avaliacao: { id, titulo } | null,
    janela: { inicio: "ISO", fim: "ISO", minutos, rotulo: "hoje, 23:15 às 23:30" } | null,  // próxima janela livre com trabalho
    fila: [ { frente, materia, titulo, topico, minutos, inicio, prazo, critico, avaliacao, por_que } ]  // até 5, da janela
  },
  ranking: [ {               // todas as 6, ordem decrescente de prioridade
    sigla, score: 0..100,
    fatores: { urgencia: 0..1, peso: 0..1, lacuna: 0..1, carga: 0..1, risco_nota: 0..1 },
    resumo: "frase curta"
  } ],
  materias: {                // sempre as 6 chaves, mesmo sem dado
    CALC: {
      sigla, nome, tem_dados: bool, atualizado_em, recebido_em, desatualizado: bool, // >48 h sem update
      dados: { ...JSON da seção 1 } | null,
      calc: {
        proxima_avaliacao: { id, titulo, tipo, data, hora, dias_restantes, horas_restantes_ate_la, confirmada } | null,
        progresso: 0..1 | null,           // fração do conteúdo do bloco atual já dominada
        confianca: 0..1 | null,           // ver seção 4
        confianca_rotulo: "sem dado|baixa|média|alta",
        exercicios_feitos, exercicios_certos,
        horas_restantes: number | null,
        horas_disponiveis_ate_prova: number | null,
        folga_h: number | null,           // disponíveis menos restantes. Negativo = atrasado
        nota_atual: number | null, nota_necessaria: number | null,
        topicos_fracos: [ { id, nome, confianca, horas_restantes } ],  // até 3
        alvo_estudo: { id, titulo, tipo, data, dias_restantes } | null,  // ver seção 4
        simulado: { nota, max, data } | null,        // simulado mais recente do alvo
        ritmo: { h_estimadas_reduzidas, h_estudadas, fator } | null,
        horas_restantes_calibradas: number | null,   // horas_restantes x ritmo.fator
        nota_projetada: number | null,               // média final esperada (0..10)
        margem: number | null,                       // nota_projetada - media_aprovacao
        nota_projetada_motivo: string | null,        // por que a projeção ficou null, ou como projetou entregas
        garantido: number | null,                    // soma de peso_final x nota dos itens lançados
        em_jogo: number | null,                      // soma dos peso_final pendentes
        nota_necessaria_origem: "sessao|painel" | null,
        ganho_por_hora: number | null,               // pontos de média por hora de estudo no alvo
        proxima_aula: { inicio, fim, titulo } | null, // próximo evento do calendário com a sigla no título
        tempo_por_topico: { [topico_id]: minutos }    // ritmo ganha metodo: "topicos|historico"
      },
      estudo: { total_min, hoje_min, semana_min, ultima_sessao: "ISO|null", sessoes: n, sem_topico_min }
    }
  },
  agenda: [ { materia, id, titulo, tipo, data, hora, dias_restantes, peso, status, confirmada } ], // futuras ou pendentes, por data
  estudo: {
    hoje_min, semana_min, total_min, sequencia_dias,
    por_dia: [ { data: "YYYY-MM-DD", total_min, por_materia: { CALC: min } } ],  // últimos 14 dias, inclui dias zerados
    por_hora: [ 24 números ],            // minutos acumulados por hora do dia
    sessoes_recentes: [ { id, materia, topico, inicio, fim, minutos, foco, nota } ]  // 20 mais recentes
  },
  padrao: {                  // aprendido do histórico do timer
    amostra_suficiente: bool,           // false até ter pelo menos 8 sessões
    melhores_horas: [ { hora: 0..23, score } ],  // top 3
    agora_e_boa_hora: bool | null,
    texto: "frase curta"
  },
  alertas: [ { nivel: "critico|atencao|info", materia, texto } ],
  calendario: {
    ok: bool, erro: string | null, sincronizado_em: "ISO" | null,
    eventos: [ { titulo, inicio: "ISO", fim: "ISO", dia_inteiro: bool, calendario: "nome" } ],
    por_dia: [ { data: "YYYY-MM-DD", ocupado_h: number | null, livre_h } ]   // 21 dias; livre_h = estudo_min do plano / 60
  },
  plano: {
    rotina_ok: bool,                       // false: data/rotina.json ausente ou inválido, usa a padrão
    dias: [ {                              // 7 dias, hoje primeiro (hoje só o que termina depois de agora)
      data, dia_semana: "seg|ter|...", estudo_min,
      itens: [ { tipo: "ocupado|estudo", inicio, fim, titulo, origem: "rotina|calendario|sugestao",
                 materia: sigla | null, topico: { id, nome } | null,
                 frente: "estudo|preparo|triagem" | null, avaliacao: { id, titulo } | null, critico: bool } ]
    } ]
  },
  frentes: [ { id, frente, materia, titulo, avaliacao, horas, prazo: "ISO" | null,
               inicio_mais_tarde: "ISO" | null, cabe: bool, faltam_min, valor_por_hora, por_ultimo, o_que } ]
}
```

## 4. Motor de prioridade (backend)

Estatística honesta, sem fingir ML onde não há dado. Quando falta dado para uma conta, o campo
vem `null` e o motor usa a regra anterior, nunca um chute.

- **Avaliações elegíveis**: pendentes (status diferente de `entregue` e `feito`) e não
  contingentes. Contingente = título com recuperação, exame, segunda chamada, substitutiva,
  vistas ou reposição (sem diferenciar acento ou maiúscula). Contingentes seguem na agenda, mas
  nunca viram alvo nem entram em urgência, peso ou nota projetada.
- **Valor de cada avaliação**: `u = 1 / (1 + dias / 4)` (sem data: 0.15) e
  `valor = u × (0.1 + 0.9 × peso)`. Peso ausente: 0.3 se for prova, 0.05 nos outros tipos. A de
  maior valor define `fatores.urgencia`, `fatores.peso` e abre o `resumo`.
- **Alvo de estudo** (`calc.alvo_estudo`): a próxima prova elegível com data; senão uma prova
  elegível sem data; senão (matéria sem prova pendente) a elegível de maior valor. Tópicos do
  alvo: os ligados a ele; se não houver, bloco "P2"; se não houver, todos.
  `proxima_avaliacao` continua sendo a próxima pendente de qualquer tipo.
- **Confiança por tópico**: posterior Beta. `a = 1 + certos`, `b = 1 + (feitos - certos)`.
  Confiança = limite inferior do intervalo de 80% (aproximação normal). Sem exercício: `status`
  como prior fraco (nao_visto 0.05, visto 0.25, praticando 0.5, dominado 0.8). Decai desde
  `ultima_pratica` (meia-vida de 14 dias, piso de 60% do valor).
- **Confiança da matéria**: média dos tópicos do alvo, ponderada por dificuldade. Com simulado
  do alvo, vira `0.6 × (nota / max do simulado mais recente) + 0.4 × confiança por exercícios`
  (só o simulado, se não houver confiança por exercícios). `progresso` = fração dos tópicos do alvo
  com status `dominado`.
- **Horas restantes**: soma de `horas_restantes` dos tópicos do alvo (`horas_restantes_total` só
  quando o alvo não tem tópico ligado).
- **Ritmo medido** (`calc.ritmo`): o servidor grava em `data/historico.json` um snapshot diário por
  matéria (alvo, horas restantes, minutos estudados acumulados). Com pelo menos 3 sessões do timer
  na matéria, 2 snapshots do mesmo alvo em dias diferentes, mais de 60 min estudados entre eles e
  queda de horas estimadas maior que 0.1 h: `fator = h_estudadas / h_estimadas_reduzidas`,
  limitado a 0.5..3, e `horas_restantes_calibradas = horas_restantes × fator`. Sem amostra, ambos
  null e nada muda.
- **Calendário**: lê os eventos dos próximos 21 dias (todos os calendários, só leitura). Por dia:
  janela acordado de 7h às 23h30, menos a união dos eventos com hora (dia inteiro e eventos
  marcados como livres não contam), menos 2 h de refeição e deslocamento (proporcional quando
  só sobra parte da janela), limitado ao teto do `config` (semana ou fds). Hoje conta só o que
  resta. Com `calendario.ok` false, cai no modelo fixo (janela de 9h a 23h e horas do `config`).
- **Horas disponíveis até o alvo**: soma de `livre_h` de hoje até a véspera, mais o dia da prova
  até a hora dela, dividida pelo número de matérias cujo alvo com data cai até esse dia.
- **Folga**: horas disponíveis menos horas restantes (calibradas, quando houver).
- **Média de aprovação**: `media_aprovacao` da matéria; ausente vale 7.
- **Nota projetada com composição** (prioridade): vale quando `composicao` tem todos os
  `peso_final` numéricos e soma entre 0.97 e 1.03. `garantido` = soma de peso × nota dos itens
  lançados; `em_jogo` = soma dos pesos pendentes. Item pendente do alvo: `10 × confianca` da
  matéria. Entrega pendente (trabalho, tde, apresentação, lab sem tópicos ligados, ou avaliação já
  entregue aguardando nota): média ponderada das notas lançadas de itens que não são prova, ou 7 se
  não houver, e o `nota_projetada_motivo` diz qual. Demais pendentes: `10 × confiança geral`
  (média de todos os tópicos da matéria). `nota_projetada` = soma / soma dos pesos.
- **Nota necessária**: a da sessão (`nota_necessaria.valor`, origem `sessao`). Se vier null e houver
  composição válida, o painel calcula no alvo:
  `(media_aprovacao - garantido - projeção dos outros pendentes) / peso_final do alvo`, mínimo 0 e
  sem teto (acima de 10 quer dizer que não dá só com o alvo), origem `painel`.
- **Nota projetada sem composição**: notas lançadas com peso, mais cada avaliação elegível com nota
  `10 × confiança`. Se algum peso faltar ou a soma fugir de 1 por mais de 0.05, fica null e
  `nota_projetada_motivo` explica. `margem = nota_projetada - media_aprovacao`.
- **Fatores**: `urgencia` e `peso` da avaliação de maior valor; `lacuna = 1 - confianca` (0.5 sem
  dado); `carga = horas restantes / horas disponíveis`, limitado a 0..1.5 e normalizado;
  `risco_nota = 1 / (1 + e^(k × margem))` com `k = ln 9 / 2` (margem -2 dá 0.9, 0 dá 0.5, +2 dá
  0.1). Sem margem, risco = quanto a nota necessária passa de 7 ou a nota atual fica abaixo da média.
- **Score** = 100 × (0.30 urgência + 0.15 peso + 0.15 lacuna + 0.15 carga + 0.25 risco), mais
  bônus de até 10 quando `folga_h < 0` (2 por hora de atraso).
- **Ganho por hora** (`calc.ganho_por_hora`): `peso do alvo × 10 × (1 - confianca) / max(horas, 1)`,
  null sem peso. Desempata o ranking e, na recomendação, entre as matérias a até 3 pontos do topo
  vence o maior ganho, citado no motivo.
- **Hora do dia**: do histórico de sessões, média de minutos e de `foco` por hora, suavizada
  (pseudo-contagem 3). Hora boa (score de pelo menos 1.05): tópico mais difícil e bloco de 75 min.
  Hora fraca (até 0.95): tópico mais leve e bloco de 30 min. Senão, tópico mais fraco e 50 min.
  Com menos de 8 sessões, não ajusta nada e diz isso em `padrao.texto`.
- **Bloco e calendário** (só sem fila): se um evento com hora começa antes do fim do bloco, o bloco
  encolhe para caber (mínimo 20 min) e o motivo cita o evento.
- **Anti-monotonia**: se a matéria do topo já teve mais de 120 min hoje, oferece a segunda como
  `alternativa`.
- **Alertas**: prova ou avaliação com estudo em até 3 dias; entrega ou apresentação sem estudo em
  até 2 dias, com texto de ação; atraso em relação ao alvo; matéria sem dado ou desatualizada;
  datas não confirmadas (1 linha por matéria); timer aberto há mais de 3 h.

- **Rotina e janelas** (`data/rotina.json`): ocupado do dia = rotina do dia da semana mais eventos
  com hora do calendário (os que caem dentro de um compromisso da rotina ficam absorvidos). Dia
  inteiro não ocupa; evento de dia inteiro com "feriado" no título tira Estágio e Faculdade do dia.
  Janela livre: de `acorda + preparo_min` até `dorme`, menos o ocupado, mais `descanso_chegada_min`
  depois de Estágio ou Faculdade. Hoje começa em agora (arredondado para cima a 5 min). Cada janela
  vira blocos de `bloco_min` com `pausa_min` entre eles; sobra menor que `bloco_minimo_min` é
  descartada. Fim de semana: o teto `horas_dia_fds` corta os últimos blocos. `dorme_hoje` e
  `acorda_amanha` do config substituem a rotina até o próximo despertar.
  `livre_h` do dia = minutos em blocos / 60, e as horas disponíveis até o alvo somam esses blocos
  (no dia da prova, só os que acabam antes da hora dela).
- **Frentes de trabalho** (`State.frentes`):
  - `preparo`: avaliação elegível com `preparo.horas_restantes > 0`. Prazo = data e hora; sem hora,
    o primeiro compromisso do dia; sem compromisso, 08:00. Valor = peso (prova sem peso 0.1, outros
    0.05) × 10, dividido pelas horas.
  - `estudo`: tópicos do alvo, horas = restantes (calibradas se houver), prazo = data e hora do alvo
    (sem hora, 00:00 do dia), valor por hora = `ganho_por_hora` (senão score / 100 × 0.1).
  - `triagem`: matéria fora de `por_ultimo` com aula nas próximas 36 h (evento com a sigla como
    palavra no título) e avaliação elegível até o dia da aula sem `preparo`, ou dados com mais de
    24 h. 15 min, prazo = início da aula, valor 0.2. Some quando a sessão manda `preparo` ou quando há
    sessão cronometrada da matéria depois de 36 h antes da aula.
- **Reserva de trás para frente**: frentes com prazo, por prazo decrescente, reservam os blocos mais
  tardios antes do prazo. Isso dá `inicio_mais_tarde`. Se não cabe: `cabe: false`, `faltam_min`,
  alerta crítico e a frente é crítica desde já.
- **Alocação** (próximos 7 dias, em ordem de horário): em cada bloco, (a) crítica (o
  `inicio_mais_tarde` já chegou) com prazo mais próximo; triagem com aula em menos de 24 h é crítica
  no último bloco antes da aula ou no último bloco da véspera, e ocupa só 15 min; (b) véspera de
  prova: blocos pares para a matéria da prova; (c) maior `valor_por_hora × (1 + 2 / (1 + dias até o
  prazo)) × 0.8^(blocos já dados à frente no dia)`, no máximo 2 blocos seguidos da mesma matéria
  salvo crítica. Preparo vem antes do estudo da mesma matéria quando o prazo do preparo é em menos
  de 36 h. Matéria em `por_ultimo` só entra se sobrar bloco (máximo 1 por dia). Sobra de bloco de
  15 min ou mais vai para a próxima escolha; menor, fica no mesmo item. Tópico do estudo: o mais
  fraco com horas, avançando conforme consome; no primeiro bloco da manhã, o mais difícil.
  Sem nenhuma frente: bloco "Livre".
- **Recomendação**: segue a `fila` (itens da próxima janela livre contígua com trabalho). Matéria,
  tópico, frente e avaliação vêm do primeiro item; `bloco_sugerido_min` = minutos até o fim dele
  se começa em até 10 min, senão a duração. O `motivo` explica a ordem da fila. Sem fila, vale a
  recomendação por ranking (com desempate por ganho por hora e ajuste por hora do dia). Se agora é
  um compromisso, o motivo diz quando é o próximo bloco livre.
- **Timer automático** (`POST /api/timer/ping`): sem timer, abre um de origem `sessao`; mesma matéria
  e tópico, só atualiza `ultimo_ping`; tópico diferente, fecha o trecho e abre outro; outra matéria,
  fecha e abre, salvo timer do painel com menos de 5 min (responde `ignorado: true`). Timer do
  painel na mesma matéria recebe tópico e `ultimo_ping` sem mudar a origem. Timer com ping e sem
  ping há mais de 12 min fecha sozinho com fim = último ping + 2 min (checado a cada 30 s e ao
  subir). Timer do painel sem ping segue manual. Trecho com menos de 60 s é descartado. Tópico
  casado por id, ou pelo nome exato sem acento e maiúscula.
- **Ritmo por tópicos** (prioridade sobre o histórico): tópicos concluídos (`dominado` ou 0 h) com
  `horas_estimadas_inicial` e tempo cronometrado. Com 2 ou mais, ou 90 min ou mais neles:
  `fator = minutos reais / (estimativa × 60)`, limitado a 0.3..3, `metodo: "topicos"`.

## 5. Sempre no ar

LaunchAgent `local.painel-estudos` com `RunAtLoad` e `KeepAlive`, apontando para
`/opt/homebrew/bin/node server.js`, log em `data/server.log`. Testes: `./test.sh` (dados e porta temporários). O frontend reconecta o SSE sozinho e
mostra um indicador de conexão.
