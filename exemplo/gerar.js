#!/usr/bin/env node
// Gera dados FICTÍCIOS em data/ para ver o painel funcionando. Datas relativas a hoje.
// Uso: node exemplo/gerar.js [--forcar]
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.resolve(process.env.PAINEL_DATA_DIR || path.join(__dirname, '..', 'data'));
const MAT = path.join(DATA, 'materias');
if (fs.existsSync(MAT) && fs.readdirSync(MAT).length && !process.argv.includes('--forcar')) {
  console.error('data/materias já tem arquivos. Use --forcar para sobrescrever.'); process.exit(1);
}
fs.mkdirSync(MAT, { recursive: true });
const dia = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const agora = new Date().toISOString();
const top = (id, nome, status, feitos, certos, teoria, pratica, dif = 3) => ({
  id, nome, bloco: 'P2', dificuldade: dif, status, exercicios_feitos: feitos, exercicios_certos: certos,
  horas_teoria_restantes: teoria, horas_pratica_restantes: pratica, horas_estimadas_inicial: teoria + pratica + 1,
  ultima_pratica: feitos ? dia(-2) : null,
});
const disciplinas = [
  { sigla: 'CALC', cor: '#2563d9' }, { sigla: 'FIS', cor: '#d98200' }, { sigla: 'PROG', cor: '#7a4fd6' }, { sigla: 'ELET', cor: '#0c9478' },
];
const materias = {
  CALC: {
    nome: 'Cálculo II', media_aprovacao: 7, proximo_passo: 'Refazer a lista de integrais por partes, só os que errou.',
    particularidades: 'Prova sem consulta, 5 questões. Costuma cair uma de série de Taylor.',
    riscos: ['P1 abaixo da média, a P2 decide'],
    composicao: [{ item: 'P1', avaliacao_id: 'p1', peso_final: 0.4, nota: 5.5 }, { item: 'P2', avaliacao_id: 'p2', peso_final: 0.4, nota: null }, { item: 'Listas', avaliacao_id: null, peso_final: 0.2, nota: 8 }],
    avaliacoes: [
      { id: 'p1', tipo: 'prova', titulo: 'Prova 1', data: dia(-40), peso: 0.4, status: 'feito' },
      { id: 'lista4', tipo: 'trabalho', titulo: 'Lista 4: integrais impróprias', data: dia(2), peso: 0.05, status: 'pendente', confirmada: true,
        preparo: { horas_restantes: 2, o_que: 'Faltam os exercícios 6 a 10.', checklist: [{ item: 'Exercícios 1 a 5', feito: true }, { item: 'Exercícios 6 a 10', feito: false }, { item: 'Passar a limpo', feito: false }] } },
      { id: 'p2', tipo: 'prova', titulo: 'Prova 2', data: dia(8), hora: '19:00', peso: 0.4, status: 'pendente', confirmada: true, topicos: ['partes', 'improprias', 'series', 'taylor'] },
    ],
    topicos: [top('partes', 'Integração por partes', 'praticando', 12, 8, 0, 1.5), top('improprias', 'Integrais impróprias', 'visto', 4, 2, 1, 2),
      top('series', 'Séries e critérios de convergência', 'nao_visto', 0, 0, 2.5, 2.5, 4), top('taylor', 'Série de Taylor', 'nao_visto', 0, 0, 1.5, 2, 4)],
  },
  FIS: {
    nome: 'Física III', media_aprovacao: 7, proximo_passo: 'Terminar o relatório do experimento 3.',
    composicao: [{ item: 'P1', avaliacao_id: 'p1', peso_final: 0.35, nota: 7.5 }, { item: 'P2', avaliacao_id: 'p2', peso_final: 0.35, nota: null }, { item: 'Laboratório', avaliacao_id: null, peso_final: 0.3, nota: 8.5 }],
    avaliacoes: [
      { id: 'rel3', tipo: 'trabalho', titulo: 'Relatório do experimento 3', data: dia(1), hora: '08:00', peso: 0.1, status: 'pendente', confirmada: true,
        preparo: { horas_restantes: 1.5, o_que: 'Falta a análise de erro e a conclusão.', checklist: [{ item: 'Tabelas e gráficos', feito: true }, { item: 'Análise de erro', feito: false }, { item: 'Conclusão', feito: false }] } },
      { id: 'p2', tipo: 'prova', titulo: 'Prova 2', data: dia(12), hora: '08:00', peso: 0.35, status: 'pendente', confirmada: false, topicos: ['inducao', 'rlc', 'maxwell'] },
    ],
    topicos: [top('inducao', 'Indução eletromagnética', 'praticando', 9, 7, 0, 1), top('rlc', 'Circuitos RLC', 'visto', 3, 2, 1, 2), top('maxwell', 'Equações de Maxwell', 'nao_visto', 0, 0, 2, 1.5, 4)],
  },
  PROG: {
    nome: 'Estruturas de Dados', media_aprovacao: 7, proximo_passo: 'Implementar remoção em árvore AVL.',
    composicao: [{ item: 'P1', avaliacao_id: 'p1', peso_final: 0.3, nota: 8 }, { item: 'P2', avaliacao_id: 'p2', peso_final: 0.3, nota: null }, { item: 'Projeto', avaliacao_id: 'proj', peso_final: 0.4, nota: null }],
    avaliacoes: [
      { id: 'proj', tipo: 'trabalho', titulo: 'Projeto: índice invertido com tabela hash', data: dia(5), peso: 0.4, status: 'em_andamento', confirmada: true,
        preparo: { horas_restantes: 6, o_que: 'Falta a busca por prefixo e os testes.', checklist: [{ item: 'Tabela hash', feito: true }, { item: 'Busca por prefixo', feito: false }, { item: 'Testes', feito: false }, { item: 'Relatório', feito: false }] } },
      { id: 'p2', tipo: 'prova', titulo: 'Prova 2', data: dia(10), hora: '19:00', peso: 0.3, status: 'pendente', confirmada: true, topicos: ['avl', 'hash', 'grafos'] },
    ],
    topicos: [top('avl', 'Árvores AVL', 'praticando', 6, 4, 0.5, 2), top('hash', 'Tabelas hash', 'dominado', 10, 9, 0, 0, 2), top('grafos', 'Grafos: BFS e DFS', 'visto', 2, 1, 1, 2.5)],
  },
  ELET: {
    nome: 'Eletrônica Analógica', media_aprovacao: 7, proximo_passo: 'Revisar polarização de transistor antes do laboratório.',
    composicao: [{ item: 'P1', avaliacao_id: 'p1', peso_final: 0.5, nota: 6 }, { item: 'P2', avaliacao_id: 'p2', peso_final: 0.5, nota: null }],
    avaliacoes: [
      { id: 'lab6', tipo: 'apresentacao', titulo: 'Laboratório 6: amplificador emissor comum', data: dia(3), hora: '18:30', peso: 0.05, status: 'pendente', confirmada: true },
      { id: 'p2', tipo: 'prova', titulo: 'Prova 2', data: dia(15), peso: 0.5, status: 'pendente', confirmada: true, topicos: ['bjt', 'ampop', 'filtros'] },
    ],
    topicos: [top('bjt', 'Polarização de BJT', 'visto', 5, 2, 1, 2.5, 4), top('ampop', 'Amplificadores operacionais', 'nao_visto', 0, 0, 2, 2), top('filtros', 'Filtros ativos', 'nao_visto', 0, 0, 1.5, 2)],
  },
};
const grava = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 1));
grava('disciplinas.json', disciplinas);
for (const [sigla, m] of Object.entries(materias)) grava(`materias/${sigla}.json`, { sigla, atualizado_em: agora, recebido_em: agora, ...m });
grava('tarefas.json', [
  { id: 'ex1', titulo: 'Renovar matrícula do próximo semestre', materia: null, data: dia(0), feito: false, feito_em: null, criado_em: agora },
  { id: 'ex2', titulo: 'Pedir a lista de exercícios extra', materia: 'ELET', data: null, feito: false, feito_em: null, criado_em: agora },
]);
console.log(`Dados de exemplo gravados em ${DATA}. Rode: node server.js`);
