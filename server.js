'use strict';
// Painel de Estudos: servidor HTTP + SSE + motor de prioridade.
// Node puro, zero dependencias. Contrato em CONTRATO.md.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.PAINEL_DATA_DIR || path.join(ROOT, 'data'));
const MAT_DIR = path.join(DATA_DIR, 'materias');
const PUBLIC_DIR = path.join(ROOT, 'public');
const F_SESSOES = path.join(DATA_DIR, 'sessoes.json');
const F_TIMER = path.join(DATA_DIR, 'timer.json');
const F_CONFIG = path.join(DATA_DIR, 'config.json');
const F_POR_ULTIMO = path.join(DATA_DIR, 'por_ultimo.json');
function lerPorUltimo() {
  try { const v = JSON.parse(fs.readFileSync(F_POR_ULTIMO, 'utf8')); return Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : []; }
  catch (e) { return []; }
}
const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const TZ = 'America/Sao_Paulo';
// Disciplinas: data/disciplinas.json ([{ "sigla": "CALC", "cor": "#2563d9" }] ou ["CALC", ...]),
// ou a variavel PAINEL_DISCIPLINAS="CALC,FIS". Sem nenhum dos dois, usa um conjunto de exemplo.
const PALETA = ['#2563d9', '#d98200', '#7a4fd6', '#0c9478', '#d63a68', '#5a9418', '#0e8fb3', '#b0553a'];
const DISCIPLINAS = (() => {
  let bruto = null;
  if (process.env.PAINEL_DISCIPLINAS) bruto = process.env.PAINEL_DISCIPLINAS.split(',');
  else { try { bruto = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'disciplinas.json'), 'utf8')); } catch (e) { bruto = null; } }
  if (!Array.isArray(bruto) || !bruto.length) bruto = ['CALC', 'FIS', 'PROG', 'ELET'];
  const out = [];
  for (const x of bruto) {
    const sigla = String((x && typeof x === 'object' ? x.sigla : x) || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(sigla) || out.some((d) => d.sigla === sigla)) continue;
    const cor = x && typeof x === 'object' && /^#[0-9a-fA-F]{6}$/.test(x.cor || '') ? x.cor : PALETA[out.length % PALETA.length];
    out.push({ sigla, cor });
  }
  return out;
})();
const SIGLAS = DISCIPLINAS.map((d) => d.sigla);
const CONFIG_PADRAO = { horas_dia_semana: 3, horas_dia_fds: 6 };
const MIN_SESSOES_PADRAO = 8;
const MAX_BODY = 2 * 1024 * 1024;

const F_TAREFAS = path.join(DATA_DIR, 'tarefas.json');
const F_MARCAS = path.join(DATA_DIR, 'marcas.json');
// tarefas livres do usuario (com ou sem data, com ou sem materia) e marcas "pronto"/"entregue" feitas no painel
function lerTarefas() { const t = readJSON(F_TAREFAS, []); return Array.isArray(t) ? t.filter((x) => x && typeof x === 'object' && x.id) : []; }
function lerMarcas() { const m = readJSON(F_MARCAS, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }
function log(...a) { console.log(new Date().toISOString(), ...a); }
process.on('uncaughtException', (e) => log('[uncaughtException]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('[unhandledRejection]', (e && e.stack) || e));

fs.mkdirSync(MAT_DIR, { recursive: true });

// ---------------------------------------------------------------- utilitarios

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v) => {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rnd = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const pad = (n, l = 2) => String(n).padStart(l, '0');

function fmtNum(x, dec = 1) {
  if (x == null || !Number.isFinite(x)) return 'sem dado';
  return x.toLocaleString('pt-BR', { maximumFractionDigits: dec });
}
function fmtPct(x) { return `${Math.round(x * 100)}%`; }
function fmtMin(m) {
  m = Math.round(m || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${pad(r)}` : `${h}h`;
}
// Titulo curto para frases: corta em ':' ou '(' e limita o tamanho.
function curto(t, max = 40) {
  t = str(t) || 'Avaliação';
  const c = t.split(/[:(]/)[0].trim();
  if (c.length >= 3) t = c;
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const i = corte.lastIndexOf(' ');
  return `${(i > 15 ? corte.slice(0, i) : corte).replace(/[,;.\s]+$/, '')}...`;
}
const TIPOS_ACAO = { apresentacao: 'apresentar', trabalho: 'entregar', tde: 'entregar', lab: 'entregar', entrega: 'entregar', outro: 'entregar' };
function verboAcao(a) {
  const t = (a.tipo || '').toLowerCase();
  if (TIPOS_ACAO[t]) return TIPOS_ACAO[t];
  return /apresent/i.test(a.titulo) ? 'apresentar' : 'entregar';
}
function semAcento(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
// Avaliacoes contingentes (so acontecem se algo der errado) e eventos que nao sao avaliacao.
// Seguem na agenda, mas nunca viram alvo nem definem urgencia, peso ou nota projetada.
function contingente(a) {
  // so vale quando o titulo COMECA com o termo: 'Prova 2, sem recuperacao parcial' continua sendo prova
  return /^\s*(recuperacao|exame|segunda chamada|vistas|reposicao)|substitutiva|prova de recuperacao/.test(semAcento(a.titulo));
}
function fmtData(ymd) { return ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : ''; }
function quando(dias) {
  if (dias == null) return 'sem data';
  if (dias < 0) return `atrasada há ${-dias} ${-dias === 1 ? 'dia' : 'dias'}`;
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'amanhã';
  return `em ${dias} dias`;
}

// ---------------------------------------------------------------- tempo (America/Sao_Paulo)

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function parts(d) {
  const o = {};
  for (const p of dtf.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function offsetMin(d) {
  const p = parts(d);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}
function isoSP(d) {
  d = d instanceof Date ? d : new Date(d);
  const p = parts(d), off = offsetMin(d), a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(d.getMilliseconds(), 3)}` +
    `${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function ymdSP(d) { const p = parts(d); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
function horaSP(d) { const p = parts(d); return p.h + p.mi / 60; }
function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function parseHora(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return { h: +m[1], mi: +m[2], txt: `${pad(+m[1])}:${m[2]}` };
}
function ymdUTC(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function dayDiff(a, b) { return Math.round((ymdUTC(b) - ymdUTC(a)) / 86400000); }
function addDays(ymd, n) { return new Date(ymdUTC(ymd) + n * 86400000).toISOString().slice(0, 10); }
function weekday(ymd) { return new Date(ymdUTC(ymd)).getUTCDay(); }
function isWeekend(ymd) { const w = weekday(ymd); return w === 0 || w === 6; }
function spToDate(ymd, hm) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hm ? hm.h : 0, hm ? hm.mi : 0);
  return new Date(guess - offsetMin(new Date(guess)) * 60000);
}
function parseISO(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------- persistencia

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function readJSON(file, fallback, { quarentena = false } = {}) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log('erro lendo', file, e.message);
    return fallback;
  }
  try { return JSON.parse(txt); } catch (e) {
    log('JSON inválido em', file, e.message);
    if (quarentena) {
      const dest = `${file}.corrompido-${Date.now()}`;
      try { fs.renameSync(file, dest); log('arquivo movido para', dest); } catch (_) { /* segue */ }
    }
    return fallback;
  }
}

let sessoes = arr(readJSON(F_SESSOES, [], { quarentena: true })).filter((s) => obj(s) && parseISO(s.inicio));
let timer = (() => {
  const t = obj(readJSON(F_TIMER, null, { quarentena: true }));
  return t && SIGLAS.includes(t.materia) && parseISO(t.inicio) ? t : null;
})();
let config = (() => {
  const c = obj(readJSON(F_CONFIG, null, { quarentena: true })) || {};
  return {
    horas_dia_semana: num(c.horas_dia_semana) ?? CONFIG_PADRAO.horas_dia_semana,
    horas_dia_fds: num(c.horas_dia_fds) ?? CONFIG_PADRAO.horas_dia_fds,
    dorme_hoje: str(c.dorme_hoje),
    acorda_amanha: str(c.acorda_amanha),
    ajuste_data: str(c.ajuste_data),
    ajuste_valido_ate: str(c.ajuste_valido_ate),
  };
})();

const salvarSessoes = () => writeAtomic(F_SESSOES, sessoes);
const salvarTimer = () => writeAtomic(F_TIMER, timer);
const salvarConfig = () => writeAtomic(F_CONFIG, config);

const cacheMat = new Map(); // sigla -> { mtimeMs, size, dados }
function arquivoMateria(sigla) { return path.join(MAT_DIR, `${sigla}.json`); }
function carregarMateria(sigla) {
  const f = arquivoMateria(sigla);
  let st;
  try { st = fs.statSync(f); } catch (_) { cacheMat.delete(sigla); return null; }
  const c = cacheMat.get(sigla);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.dados;
  const d = obj(readJSON(f, null));
  cacheMat.set(sigla, { mtimeMs: st.mtimeMs, size: st.size, dados: d });
  return d;
}

// ---------------------------------------------------------------- normalizacao do dado da materia

const PRIOR_STATUS = { nao_visto: 0.05, visto: 0.25, praticando: 0.5, dominado: 0.8 };
function normStatus(s) {
  s = str(s);
  if (!s) return null;
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, '_');
}
function normPeso(v) {
  let p = num(v);
  if (p == null || p < 0) return null;
  if (p > 1 && p <= 100) p /= 100;
  return p > 1 ? null : p;
}
const PENDENTE = (status) => status !== 'entregue' && status !== 'feito';

function normPreparo(v) {
  v = obj(v);
  if (!v) return null;
  return {
    horas_restantes: num(v.horas_restantes),
    o_que: str(v.o_que),
    checklist: arr(v.checklist).map(obj).filter(Boolean).map((x) => ({ item: str(x.item) || '', feito: x.feito === true })),
  };
}
function normAvaliacao(a, i, hoje) {
  a = obj(a);
  if (!a) return null;
  const data = parseYmd(a.data);
  const hora = parseHora(a.hora);
  const status = normStatus(a.status) || 'pendente';
  return {
    id: str(a.id) || `avaliacao-${i + 1}`,
    titulo: str(a.titulo) || str(a.id) || 'Avaliação',
    tipo: str(a.tipo) || 'outro',
    data,
    hora: hora ? hora.txt : null,
    _hora: hora,
    peso: normPeso(a.peso),
    status,
    confirmada: a.confirmada === true ? true : a.confirmada === false ? false : null,
    topicos: arr(a.topicos).map(str).filter(Boolean),
    dias_restantes: data ? dayDiff(hoje, data) : null,
    preparo: normPreparo(a.preparo),
  };
}
function normTopico(t, i) {
  t = obj(t);
  if (!t) return null;
  return {
    id: str(t.id) || `topico-${i + 1}`,
    nome: str(t.nome) || str(t.id) || `Tópico ${i + 1}`,
    bloco: str(t.bloco),
    dificuldade: num(t.dificuldade),
    status: normStatus(t.status),
    feitos: num(t.exercicios_feitos),
    certos: num(t.exercicios_certos),
    horas_restantes: (num(t.horas_teoria_restantes) != null && num(t.horas_pratica_restantes) != null)
      ? Math.max(0, num(t.horas_teoria_restantes)) + Math.max(0, num(t.horas_pratica_restantes))
      : num(t.horas_restantes),
    horas_estimadas_inicial: num(t.horas_estimadas_inicial),
    ultima_pratica: parseYmd(t.ultima_pratica),
  };
}

// Confianca por topico: limite inferior do intervalo de 80% da posterior Beta.
function confiancaTopico(t, hoje) {
  let base = null;
  const f = t.feitos != null ? Math.max(0, Math.floor(t.feitos)) : 0;
  if (f > 0) {
    const c = clamp(Math.floor(t.certos || 0), 0, f);
    const a = 1 + c, b = 1 + f - c, n = a + b;
    const media = a / n;
    const variancia = (a * b) / (n * n * (n + 1));
    base = clamp(media - 1.2816 * Math.sqrt(variancia), 0, 1);
  } else if (t.status && PRIOR_STATUS[t.status] != null) {
    base = PRIOR_STATUS[t.status];
  }
  if (base == null) return null;
  if (t.ultima_pratica) {
    const dias = dayDiff(t.ultima_pratica, hoje);
    if (dias > 0) base *= 0.6 + 0.4 * Math.pow(0.5, dias / 14);
  }
  return base;
}

const RISCO_K = Math.log(9) / 2; // margem -2 da 0,9; 0 da 0,5; +2 da 0,1

function mediaConf(topicos) {
  let sw = 0, sc = 0;
  for (const t of topicos) {
    if (t.confianca == null) continue;
    const w = t.dificuldade != null && t.dificuldade > 0 ? t.dificuldade : 1;
    sw += w; sc += w * t.confianca;
  }
  return sw > 0 ? sc / sw : null;
}

const MEDIA_PADRAO = 7; // media de aprovacao quando a materia nao informa 
const TIPOS_ENTREGA = new Set(['entrega', 'trabalho', 'tde', 'apresentacao', 'lab']);
const RX_PROVA = /\bprova\b|\bp\d\b|\bteste\b|\bexame\b|\bavaliacao\b|\bquiz\b/;
const RX_ENTREGA = /\blab|\btde|\btrabalho|\blista|\bentrega|\bapresenta|\bap\d|\bvisto|\bpjbl|\bsomativa|\brelatorio|\bs\d\b/;

// Projecao pela composicao da media final enviada pela sessao.
function projetarComposicao(d, b, alvo, confAlvo, media) {
  const itens = arr(d.composicao).map(obj).filter(Boolean);
  if (!itens.length) return { valida: false, motivo: null };
  const norm = itens.map((x) => ({
    item: str(x.item) || 'item',
    av_id: str(x.avaliacao_id),
    peso: num(x.peso_final),
    nota: num(x.nota),
  }));
  if (norm.some((x) => x.peso == null || x.peso < 0)) return { valida: false, motivo: 'composição com peso faltando' };
  const soma = norm.reduce((a, x) => a + x.peso, 0);
  if (soma < 0.97 || soma > 1.03) return { valida: false, motivo: `composição soma ${fmtNum(soma * 100, 0)}%` };

  const porId = new Map(b.avaliacoes.map((a) => [a.id, a]));
  const ehProvaItem = (x) => {
    const av = x.av_id ? porId.get(x.av_id) : null;
    if (av) return av.tipo.toLowerCase() === 'prova';
    return RX_PROVA.test(semAcento(x.item)) && !RX_ENTREGA.test(semAcento(x.item));
  };
  // item pendente que nao depende de estudo: entrega sem topicos, ou ja entregue esperando nota
  const ehEntregaItem = (x) => {
    const av = x.av_id ? porId.get(x.av_id) : null;
    if (av) {
      if (!PENDENTE(av.status)) return av.tipo.toLowerCase() !== 'prova';
      const t = av.tipo.toLowerCase();
      return av._ligados.length === 0 && (TIPOS_ENTREGA.has(t) || (t === 'outro' && RX_ENTREGA.test(semAcento(av.titulo))));
    }
    return !ehProvaItem(x) && RX_ENTREGA.test(semAcento(x.item));
  };

  let garantido = 0, em_jogo = 0;
  let pLanc = 0, pnLanc = 0;
  for (const x of norm) {
    if (x.nota != null) {
      garantido += x.peso * x.nota;
      if (!ehProvaItem(x)) { pLanc += x.peso; pnLanc += x.peso * x.nota; }
    } else {
      em_jogo += x.peso;
    }
  }
  const mediaEntregas = pLanc > 0 ? pnLanc / pLanc : null;
  const notaEntrega = mediaEntregas != null ? mediaEntregas : 7;
  const confGeral = mediaConf(b.topicos) ?? confAlvo;

  let projOutros = 0, pAlvo = 0, projAlvo = 0, usouEntrega = false, faltaConf = false;
  for (const x of norm) {
    if (x.nota != null) continue;
    const doAlvo = alvo && x.av_id && x.av_id === alvo.id;
    let n;
    if (doAlvo) {
      if (confAlvo == null) { faltaConf = true; continue; }
      n = 10 * confAlvo;
      pAlvo += x.peso; projAlvo += x.peso * n;
      continue;
    }
    if (ehEntregaItem(x)) { n = notaEntrega; usouEntrega = true; }
    else if (confGeral != null) n = 10 * confGeral;
    else { faltaConf = true; continue; }
    projOutros += x.peso * n;
  }
  const res = { valida: true, garantido, em_jogo, nota_projetada: null, nota_necessaria: null, motivo: null };
  // nota necessaria no alvo: o que falta para a media, dado o garantido e a projecao do resto
  if (pAlvo > 0 || (alvo && norm.some((x) => x.av_id === alvo.id && x.nota == null))) {
    const pa = norm.filter((x) => alvo && x.av_id === alvo.id && x.nota == null).reduce((a, x) => a + x.peso, 0);
    if (pa > 0 && !faltaConf) res.nota_necessaria = Math.max(0, (media - garantido - projOutros) / pa);
  }
  if (faltaConf) { res.motivo = 'sem confiança para projetar os itens pendentes'; return res; }
  res.nota_projetada = (garantido + projOutros + projAlvo) / soma;
  if (usouEntrega) {
    res.motivo = mediaEntregas != null
      ? `Entregas pendentes projetadas pela média das entregas já lançadas (${fmtNum(mediaEntregas)}).`
      : 'Entregas pendentes projetadas com 7, sem entrega lançada para comparar.';
  }
  return res;
}

// ---------------------------------------------------------------- historico diario (ritmo medido)

const F_HIST = path.join(DATA_DIR, 'historico.json');
let historico = obj(readJSON(F_HIST, {}, { quarentena: true })) || {};

// Ritmo: compara o snapshot mais antigo e o mais recente do mesmo alvo, em dias diferentes.
function calcRitmo(sigla, alvo) {
  if (!alvo) return null;
  const nTimer = sessoes.filter((x) => x.materia === sigla && x.origem === "timer").length;
  if (nTimer < 3) return null;
  const snaps = Object.keys(historico).filter((d) => parseYmd(d)).sort()
    .map((d) => ({ d, s: obj(obj(historico[d]) && historico[d][sigla]) }))
    .filter((x) => x.s && x.s.alvo === alvo.id && num(x.s.horas_restantes) != null && num(x.s.min_estudados) != null);
  if (snaps.length < 2) return null;
  const a = snaps[0], z = snaps[snaps.length - 1];
  if (a.d === z.d) return null;
  const min = num(z.s.min_estudados) - num(a.s.min_estudados);
  const reduzidas = num(a.s.horas_restantes) - num(z.s.horas_restantes);
  if (!(min > 60) || !(reduzidas > 0.1)) return null;
  const estudadas = min / 60;
  return { h_estimadas_reduzidas: rnd(reduzidas), h_estudadas: rnd(estudadas), fator: rnd(clamp(estudadas / reduzidas, 0.5, 3), 2), metodo: 'historico' };
}

// Ritmo pelos topicos concluidos: minutos reais contra a estimativa inicial de cada um.
function ritmoTopicos(topicos, tempo) {
  let est = 0, real = 0, n = 0;
  for (const t of topicos) {
    const concluido = t.status === 'dominado' || t.horas_restantes === 0;
    const min = tempo[t.id] || 0;
    if (!concluido || !(t.horas_estimadas_inicial > 0) || !(min > 0)) continue;
    est += t.horas_estimadas_inicial * 60; real += min; n++;
  }
  if (!(n >= 2 || real >= 90) || !(est > 0)) return null;
  return { h_estimadas_reduzidas: rnd(est / 60), h_estudadas: rnd(real / 60), fator: rnd(clamp(real / est, 0.3, 3), 2), metodo: 'topicos' };
}

// Casa o topico de uma sessao/ping com os topicos da materia: por id, senao pelo nome exato.
function casarTopico(topicos, id, nome) {
  id = str(id); nome = str(nome);
  if (id) {
    const t = topicos.find((x) => x.id === id);
    return { id, nome: t ? t.nome : nome };
  }
  if (nome) {
    const t = topicos.find((x) => x.id === nome) || topicos.find((x) => semAcento(x.nome) === semAcento(nome));
    return t ? { id: t.id, nome: t.nome } : { id: null, nome };
  }
  return { id: null, nome: null };
}
function topicosDaMateria(sigla) {
  const d = carregarMateria(sigla);
  return d ? arr(d.topicos).map(normTopico).filter(Boolean) : [];
}
// Minutos por topico da materia (sessoes fechadas) e minutos sem topico identificado.
function tempoPorTopico(sigla, topicos) {
  const out = {};
  let sem = 0;
  for (const x of sessoes) {
    if (x.materia !== sigla) continue;
    const m = minSessao(x);
    const t = casarTopico(topicos, x.topico_id, x.topico);
    if (t.id) out[t.id] = rnd((out[t.id] || 0) + m);
    else sem += m;
  }
  return { tempo: out, sem: rnd(sem) };
}

// Grava o snapshot do dia (o ultimo do dia sobrescreve). Nunca derruba o servidor.
function gravarSnapshot() {
  try {
    const st = computeState();
    const dia = st.agora.slice(0, 10);
    const snap = {};
    for (const sigla of SIGLAS) {
      const m = st.materias[sigla];
      if (!m.tem_dados || !m.calc.alvo_estudo) continue;
      snap[sigla] = {
        alvo: m.calc.alvo_estudo.id,
        horas_restantes: m.calc.horas_restantes,
        min_estudados: m.estudo.total_min,
        em: st.agora,
      };
    }
    if (!Object.keys(snap).length) return;
    const antes = JSON.stringify(historico[dia] || {});
    historico[dia] = { ...(obj(historico[dia]) || {}), ...snap };
    if (JSON.stringify(historico[dia]) !== antes) writeAtomic(F_HIST, historico);
  } catch (e) { log('erro gravando historico:', e.message); }
}

// ---------------------------------------------------------------- estudo (sessoes)

function diaSessao(s) { const d = parseISO(s.inicio); return d ? ymdSP(d) : null; }
function minSessao(s) { const m = num(s.minutos); return m != null && m > 0 ? m : 0; }

function estudoMateria(sigla, hoje, inicioSemana) {
  let total = 0, hojeMin = 0, semana = 0, n = 0, ultima = null;
  for (const s of sessoes) {
    if (s.materia !== sigla) continue;
    const m = minSessao(s), dia = diaSessao(s);
    total += m; n++;
    if (dia === hoje) hojeMin += m;
    if (dia && dia >= inicioSemana && dia <= hoje) semana += m;
    const fim = parseISO(s.fim) || parseISO(s.inicio);
    if (fim && (!ultima || fim > ultima)) ultima = fim;
  }
  return {
    total_min: rnd(total), hoje_min: rnd(hojeMin), semana_min: rnd(semana),
    ultima_sessao: ultima ? isoSP(ultima) : null, sessoes: n,
  };
}

function estudoGeral(hoje, inicioSemana) {
  let total = 0, hojeMin = 0, semana = 0;
  const porDiaMap = new Map();
  const porHora = new Array(24).fill(0);
  for (const s of sessoes) {
    const m = minSessao(s), dia = diaSessao(s);
    total += m;
    if (dia === hoje) hojeMin += m;
    if (dia && dia >= inicioSemana && dia <= hoje) semana += m;
    if (dia) {
      const pd = porDiaMap.get(dia) || { total: 0, por: {} };
      pd.total += m;
      pd.por[s.materia] = (pd.por[s.materia] || 0) + m;
      porDiaMap.set(dia, pd);
    }
    // distribui os minutos pelas horas do dia que a sessao cobre
    const ini = parseISO(s.inicio);
    if (ini && m > 0) {
      let t = ini.getTime();
      const fimT = t + m * 60000;
      let guarda = 0;
      while (t < fimT && guarda++ < 48) {
        const prox = Math.min(fimT, (Math.floor(t / 3600000) + 1) * 3600000);
        porHora[parts(new Date(t)).h] += (prox - t) / 60000;
        t = prox;
      }
    }
  }
  const por_dia = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(hoje, -i);
    const pd = porDiaMap.get(d);
    const por = {};
    if (pd) for (const [k, v] of Object.entries(pd.por)) por[k] = rnd(v);
    por_dia.push({ data: d, total_min: pd ? rnd(pd.total) : 0, por_materia: por });
  }
  let seq = 0;
  let cursor = (porDiaMap.get(hoje) || {}).total > 0 ? hoje : addDays(hoje, -1);
  while ((porDiaMap.get(cursor) || {}).total > 0) { seq++; cursor = addDays(cursor, -1); }

  const recentes = [...sessoes]
    .sort((a, b) => parseISO(b.inicio) - parseISO(a.inicio))
    .slice(0, 20)
    .map((s) => ({
      id: s.id, materia: s.materia, topico: s.topico ?? null, inicio: s.inicio, fim: s.fim ?? null,
      minutos: rnd(minSessao(s)), foco: s.foco ?? null, nota: s.nota ?? null,
    }));
  return {
    hoje_min: rnd(hojeMin), semana_min: rnd(semana), total_min: rnd(total), sequencia_dias: seq,
    por_dia, por_hora: porHora.map((x) => rnd(x)), sessoes_recentes: recentes,
  };
}

// Padrao por hora do dia: media de minutos e de foco por hora de inicio, encolhida para a media geral.
function calcPadrao(now) {
  const n = sessoes.length;
  const horaAgora = parts(now).h;
  if (n < MIN_SESSOES_PADRAO) {
    return {
      amostra_suficiente: false, melhores_horas: [], agora_e_boa_hora: null,
      texto: n === 0
        ? `Ainda não há sessões registradas. Com ${MIN_SESSOES_PADRAO} sessões começo a ler seu melhor horário.`
        : `${n} de ${MIN_SESSOES_PADRAO} sessões registradas. Até lá não ajusto nada pela hora do dia.`,
      _score: null,
    };
  }
  const cnt = new Array(24).fill(0), soma = new Array(24).fill(0);
  const cntF = new Array(24).fill(0), somaF = new Array(24).fill(0);
  let totM = 0, totF = 0, nF = 0;
  for (const s of sessoes) {
    const ini = parseISO(s.inicio);
    if (!ini) continue;
    const h = parts(ini).h, m = minSessao(s);
    cnt[h]++; soma[h] += m; totM += m;
    const f = num(s.foco);
    if (f != null) { cntF[h]++; somaF[h] += f; totF += f; nF++; }
  }
  const M = totM / n, F = nF ? totF / nF : null;
  const K = 3;
  const score = new Array(24).fill(null);
  for (let h = 0; h < 24; h++) {
    if (!cnt[h] || !(M > 0)) continue;
    const mS = (soma[h] + K * M) / (cnt[h] + K);
    if (F != null && F > 0) {
      const fS = (somaF[h] + K * F) / (cntF[h] + K);
      score[h] = 0.5 * (mS / M) + 0.5 * (fS / F);
    } else {
      score[h] = mS / M;
    }
  }
  const melhores = score
    .map((s, h) => ({ hora: h, score: s }))
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score || a.hora - b.hora)
    .slice(0, 3)
    .map((x) => ({ hora: x.hora, score: rnd(x.score, 2) }));
  const sAgora = score[horaAgora];
  let agora = null;
  if (sAgora != null) {
    if (sAgora >= 1.05) agora = true;
    else if (sAgora <= 0.95) agora = false;
  }
  const lista = melhores.map((x) => `${x.hora}h`);
  const listaTxt = lista.length > 1 ? `${lista.slice(0, -1).join(', ')} e ${lista[lista.length - 1]}` : lista[0];
  let fraseAgora;
  if (sAgora == null) fraseAgora = `Ainda não há sessão começada às ${horaAgora}h.`;
  else if (agora === true) fraseAgora = `Agora (${horaAgora}h) é hora boa.`;
  else if (agora === false) fraseAgora = `Agora (${horaAgora}h) rende abaixo da sua média.`;
  else fraseAgora = `Agora (${horaAgora}h) está na sua média.`;
  return {
    amostra_suficiente: true,
    melhores_horas: melhores,
    agora_e_boa_hora: agora,
    texto: `Com ${n} sessões, você rende mais às ${listaTxt}. ${fraseAgora}`,
    _score: score,
  };
}

// ---------------------------------------------------------------- calendario (somente leitura)

const F_CAL = path.join(DATA_DIR, 'calendario.json');
const CAL_BIN = process.env.PAINEL_CAL_BIN || path.join(ROOT, 'calendario', 'ler-calendario');
const CAL_SYNC = process.env.PAINEL_CAL_SYNC !== '0';
const CAL_DIAS = 21;
const CAL_INTERVALO_MS = 5 * 60 * 1000;
const JANELA_INI = { h: 7, mi: 0 }, JANELA_FIM = { h: 23, mi: 30 };
const REFEICAO_H = 2;

let cal = (() => {
  const c = obj(readJSON(F_CAL, null, { quarentena: true })) || {};
  return {
    ok: c.ok === true,
    erro: str(c.erro),
    sincronizado_em: str(c.sincronizado_em),
    eventos: arr(c.eventos).map(normEvento).filter(Boolean),
  };
})();

function normEvento(e) {
  e = obj(e);
  if (!e) return null;
  const ini = parseISO(e.inicio), fim = parseISO(e.fim);
  if (!ini || !fim || fim < ini) return null;
  return {
    titulo: str(e.titulo) || 'Evento',
    inicio: isoSP(ini),
    fim: isoSP(fim),
    dia_inteiro: e.dia_inteiro === true,
    calendario: str(e.calendario) || '',
    livre: e.disponibilidade === 'livre',
    _ini: ini.getTime(),
    _fim: fim.getTime(),
  };
}

let calRodando = false;
function sincronizarCalendario() {
  if (!CAL_SYNC || calRodando) return;
  if (!fs.existsSync(CAL_BIN)) {
    cal = { ...cal, ok: false, erro: 'Leitor do calendário não compilado (calendario/ler-calendario).' };
    mudou();
    return;
  }
  calRodando = true;
  execFile(CAL_BIN, [String(CAL_DIAS)], { timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
    calRodando = false;
    try {
      if (e) throw new Error(`Leitura do calendário falhou: ${e.killed ? 'tempo esgotado' : e.message.split('\n')[0]}`);
      const r = JSON.parse(out);
      if (!r.ok) throw new Error(str(r.erro) || 'Leitura do calendário falhou.');
      cal = { ok: true, erro: null, sincronizado_em: isoSP(new Date()), eventos: arr(r.eventos).map(normEvento).filter(Boolean) };
    } catch (err) {
      cal = { ...cal, ok: false, erro: err.message };
      log('calendário:', err.message);
    }
    try {
      writeAtomic(F_CAL, {
        ok: cal.ok, erro: cal.erro, sincronizado_em: cal.sincronizado_em,
        eventos: cal.eventos.map(({ _ini, _fim, livre, ...ev }) => ({ ...ev, disponibilidade: livre ? 'livre' : 'ocupado' })),
      });
    } catch (err) { log('erro gravando calendario.json:', err.message); }
    mudou();
  });
}

// Uniao de intervalos [a,b] em ms, recortada em [ini,fim]. Devolve horas ocupadas.
function horasOcupadas(ini, fim) {
  const iv = [];
  for (const ev of cal.eventos) {
    if (ev.dia_inteiro || ev.livre) continue;
    const a = Math.max(ev._ini, ini), b = Math.min(ev._fim, fim);
    if (b > a) iv.push([a, b]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  let tot = 0, ca = null, cb = null;
  for (const [a, b] of iv) {
    if (ca == null || a > cb) { if (ca != null) tot += cb - ca; ca = a; cb = b; } else cb = Math.max(cb, b);
  }
  if (ca != null) tot += cb - ca;
  return tot / 3600000;
}

// Horas livres de estudo num dia pelo calendario. `ateHora` corta a janela (dia da prova).
function livreDiaCal(ymd, now, ateHora) {
  const jIni = spToDate(ymd, JANELA_INI).getTime();
  let jFim = spToDate(ymd, JANELA_FIM).getTime();
  if (ateHora) jFim = Math.min(jFim, spToDate(ymd, ateHora).getTime());
  const cheia = (spToDate(ymd, JANELA_FIM) - spToDate(ymd, JANELA_INI)) / 3600000;
  const ini = Math.max(jIni, now.getTime());
  if (jFim <= ini) return { ocupado: 0, livre: 0 };
  const janela = (jFim - ini) / 3600000;
  const ocupado = horasOcupadas(ini, jFim);
  const refeicao = REFEICAO_H * (janela / cheia);
  const livre = clamp(janela - ocupado - refeicao, 0, horasDia(ymd));
  return { ocupado, livre };
}

function calendarioState(now) {
  const hoje = ymdSP(now);
  const iniJan = spToDate(hoje, { h: 0, mi: 0 }).getTime();
  const fimJan = spToDate(addDays(hoje, CAL_DIAS), { h: 0, mi: 0 }).getTime();
  const por_dia = [];
  for (let i = 0; i < CAL_DIAS; i++) {
    const d = addDays(hoje, i);
    const J = janelasAtuais && janelasAtuais.get(d);
    if (J) {
      por_dia.push({ data: d, ocupado_h: rnd(J.ocupado_h), livre_h: rnd(J.estudo_min / 60) });
    } else if (cal.ok) {
      const r = livreDiaCal(d, now, null);
      por_dia.push({ data: d, ocupado_h: rnd(r.ocupado), livre_h: rnd(r.livre) });
    } else {
      const est = i === 0 ? horasLivresAte(hoje, horaSP(now), 0, null) : horasDia(d);
      por_dia.push({ data: d, ocupado_h: null, livre_h: rnd(est) });
    }
  }
  return {
    ok: cal.ok,
    erro: cal.erro,
    sincronizado_em: cal.sincronizado_em,
    eventos: cal.eventos
      .filter((e) => e._fim > iniJan && e._ini < fimJan)
      .map((e) => ({ titulo: e.titulo, inicio: e.inicio, fim: e.fim, dia_inteiro: e.dia_inteiro, calendario: e.calendario })),
    por_dia,
  };
}

// Proximo evento com hora que comeca depois de agora.
function proximoEvento(now) {
  let melhor = null;
  for (const e of cal.eventos) {
    if (e.dia_inteiro || e.livre || e._ini <= now.getTime()) continue;
    if (!melhor || e._ini < melhor._ini) melhor = e;
  }
  return melhor;
}

// ---------------------------------------------------------------- rotina e plano de blocos

const F_ROTINA = path.join(DATA_DIR, 'rotina.json');
const ROTINA_PADRAO = {
  acorda: '07:00', dorme: '23:00', preparo_min: 10, descanso_chegada_min: 15,
  bloco_min: 50, pausa_min: 10, bloco_minimo_min: 25,
  dias: {
    seg: [{ de: '08:00', ate: '12:00', titulo: 'Faculdade' }, { de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    ter: [{ de: '08:00', ate: '12:00', titulo: 'Faculdade' }, { de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    qua: [{ de: '08:00', ate: '12:00', titulo: 'Faculdade' }, { de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    qui: [{ de: '08:00', ate: '12:00', titulo: 'Faculdade' }, { de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    sex: [{ de: '08:00', ate: '12:00', titulo: 'Faculdade' }, { de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    sab: [{ de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
    dom: [{ de: '12:00', ate: '13:00', titulo: 'Almoço' }, { de: '19:30', ate: '20:10', titulo: 'Jantar' }],
  },
};
const DIAS_SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const PLANO_DIAS = 7;
const RX_SAIDA = /estagio|faculdade/;

function minHM(v) { const h = parseHora(v); return h ? h.h * 60 + h.mi : null; }
function normRotina(r) {
  r = obj(r);
  if (!r) return null;
  const nn = (v, d, lo, hi) => { const x = num(v); return x != null && x >= lo && x <= hi ? x : d; };
  const acorda = minHM(r.acorda) ?? minHM(ROTINA_PADRAO.acorda);
  const dorme = minHM(r.dorme) ?? minHM(ROTINA_PADRAO.dorme);
  if (dorme <= acorda) return null;
  const rd = obj(r.dias) || {};
  const dias = {};
  for (const k of DIAS_SEM) {
    dias[k] = arr(rd[k]).map(obj).filter(Boolean)
      .map((x) => ({ de: minHM(x.de), ate: minHM(x.ate), titulo: str(x.titulo) || 'Ocupado' }))
      .filter((x) => x.de != null && x.ate != null && x.ate > x.de);
  }
  return {
    acorda, dorme,
    preparo: nn(r.preparo_min, 10, 0, 240), descanso: nn(r.descanso_chegada_min, 15, 0, 240),
    bloco: nn(r.bloco_min, 50, 10, 300), pausa: nn(r.pausa_min, 10, 0, 120), minimo: nn(r.bloco_minimo_min, 25, 5, 300),
    dias,
  };
}
let cacheRotina = null;
function lerRotina() {
  let st;
  try { st = fs.statSync(F_ROTINA); } catch (_) { return { rotina: normRotina(ROTINA_PADRAO), ok: false }; }
  if (cacheRotina && cacheRotina.mtimeMs === st.mtimeMs && cacheRotina.size === st.size) return cacheRotina;
  const r = normRotina(readJSON(F_ROTINA, null));
  if (!r) log('rotina.json inválido, usando a rotina padrão');
  cacheRotina = { mtimeMs: st.mtimeMs, size: st.size, rotina: r || normRotina(ROTINA_PADRAO), ok: !!r };
  return cacheRotina;
}

function uniao(iv) {
  const o = iv.filter((x) => x.fim > x.ini).map((x) => [x.ini, x.fim]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of o) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
function minParaDate(ymd, min) {
  if (min >= 1440) return spToDate(addDays(ymd, 1), { h: 0, mi: min - 1440 });
  return spToDate(ymd, { h: Math.floor(min / 60), mi: min % 60 });
}

// Janelas do dia: ocupados (rotina + calendario) e blocos de estudo possiveis. Nao depende do score.
function janelasDia(ymd, now, rot, ehHoje) {
  const T = (m) => minParaDate(ymd, m).getTime();
  const diaIni = T(0), diaFim = spToDate(addDays(ymd, 1), { h: 0, mi: 0 }).getTime();
  const evs = cal.ok ? cal.eventos : [];
  const feriado = evs.some((e) => e.dia_inteiro && /feriado/.test(semAcento(e.titulo)) && e._ini < diaFim && e._fim > diaIni);
  const rotItens = (rot.dias[DIAS_SEM[weekday(ymd)]] || [])
    .filter((x) => !(feriado && RX_SAIDA.test(semAcento(x.titulo))))
    .map((x) => ({ ini: T(x.de), fim: T(x.ate), titulo: x.titulo, origem: 'rotina' }));
  const calItens = evs
    .filter((e) => !e.dia_inteiro && !e.livre && e._ini < diaFim && e._fim > diaIni)
    .map((e) => ({ ini: Math.max(e._ini, diaIni), fim: Math.min(e._fim, diaFim), titulo: e.titulo, origem: 'calendario' }))
    .filter((e) => !rotItens.some((r) => e.ini >= r.ini && e.fim <= r.fim));
  const bloqueios = uniao([
    ...rotItens.map((r) => ({ ini: r.ini, fim: r.fim + (RX_SAIDA.test(semAcento(r.titulo)) ? rot.descanso * 60000 : 0) })),
    ...calItens,
  ]);
  let jIni = T(rot.acorda + rot.preparo);
  const jFim = T(rot.dorme);
  if (ehHoje) jIni = Math.max(jIni, Math.ceil(now.getTime() / 300000) * 300000);
  // janelas livres
  const livres = [];
  let t = jIni;
  for (const [a, b] of bloqueios) {
    if (b <= t) continue;
    if (a >= jFim) break;
    if (a > t) livres.push([t, Math.min(a, jFim)]);
    t = Math.max(t, b);
  }
  if (t < jFim) livres.push([t, jFim]);
  // fatia em blocos
  let blocos = [];
  for (const [jan, [a, b]] of livres.entries()) {
    let x = a;
    while (b - x >= rot.minimo * 60000) {
      const len = Math.min(rot.bloco * 60000, b - x);
      blocos.push({ ini: x, fim: x + len, jan });
      x += len + rot.pausa * 60000;
    }
  }
  // fim de semana: teto do config corta os ultimos blocos
  if (isWeekend(ymd)) {
    const teto = config.horas_dia_fds * 60 * 60000;
    let acc = 0;
    const cortados = [];
    for (const bl of blocos) {
      const len = bl.fim - bl.ini;
      if (acc + len <= teto) { cortados.push(bl); acc += len; continue; }
      const resto = teto - acc;
      if (resto >= rot.minimo * 60000) cortados.push({ ini: bl.ini, fim: bl.ini + resto });
      break;
    }
    blocos = cortados;
  }
  const oIni = ehHoje ? Math.max(T(rot.acorda), now.getTime()) : T(rot.acorda);
  let ocup = 0;
  for (const [a, b] of uniao([...rotItens, ...calItens])) {
    const x = Math.max(a, oIni), y = Math.min(b, jFim);
    if (y > x) ocup += y - x;
  }
  return {
    data: ymd,
    dia_semana: DIAS_SEM[weekday(ymd)],
    ocupados: [...rotItens, ...calItens],
    blocos,
    estudo_min: blocos.reduce((a, x) => a + (x.fim - x.ini), 0) / 60000,
    ocupado_h: ocup / 3600000,
  };
}

let janelasAtuais = null; // Map data -> janelasDia, recalculado a cada computeState
// Ajuste de hoje (dorme_hoje / acorda_amanha), valido ate o proximo despertar.
function ajusteValido(now) {
  if (!config.ajuste_data || !config.ajuste_valido_ate) return null;
  const ate = parseISO(config.ajuste_valido_ate);
  if (!ate || now >= ate) return null;
  return { data: config.ajuste_data, dorme: config.dorme_hoje, acorda: config.acorda_amanha };
}
function calcularJanelas(now) {
  const { rotina } = lerRotina();
  const hoje = ymdSP(now);
  const aj = ajusteValido(now);
  const m = new Map();
  for (let i = 0; i < CAL_DIAS; i++) {
    const d = addDays(hoje, i);
    let rot = rotina;
    if (aj && d === aj.data && aj.dorme) {
      let dm = minHM(aj.dorme);
      if (dm != null && dm <= rotina.acorda) dm += 1440; // passa da meia-noite
      if (dm != null) rot = { ...rot, dorme: dm };
    }
    if (aj && d === addDays(aj.data, 1) && aj.acorda) {
      const ac = minHM(aj.acorda);
      if (ac != null && ac < rot.dorme) rot = { ...rot, acorda: ac };
    }
    m.set(d, janelasDia(d, now, rot, i === 0));
  }
  return m;
}

// ---------------------------------------------------------------- agendador de frentes de trabalho

const DIA_MS = 86400000;
const TRIAGEM_MIN = 15;
function hhmm(ms) { return isoSP(new Date(ms)).slice(11, 16); }
function rotuloDia(ms, now) {
  const d = ymdSP(new Date(ms));
  const dd = dayDiff(ymdSP(now), d);
  if (dd === 0) return 'hoje';
  if (dd === 1) return 'amanhã';
  return `${DIAS_SEM[weekday(d)]} ${fmtData(d)}`;
}
function rotuloQuando(ms, now) { return `${rotuloDia(ms, now)} às ${hhmm(ms)}`; }
function rotuloJanela(ini, fim, now) {
  let dia = rotuloDia(ini, now);
  if (dia === 'amanhã' && horaSP(new Date(ini)) < 12) dia = 'amanhã cedo';
  return `${dia}, ${hhmm(ini)} às ${hhmm(fim)}`;
}
function rxSigla(sigla) { return new RegExp(`(^|[^A-Za-z0-9])${sigla}([^A-Za-z0-9]|$)`, 'i'); }
// Proxima aula da materia: evento com hora do calendario cujo titulo tem a sigla como palavra.
function proximaAula(sigla, now) {
  if (!cal.ok) return null;
  const rx = rxSigla(sigla);
  let m = null;
  for (const e of cal.eventos) {
    if (e.dia_inteiro || e._ini <= now.getTime() || !rx.test(e.titulo)) continue;
    if (!m || e._ini < m._ini) m = e;
  }
  return m;
}
// Prazo de uma avaliacao: data + hora; sem hora, o primeiro compromisso do dia; senao 08:00.
function prazoAvaliacao(a) {
  if (!a.data) return null;
  if (a._hora) return spToDate(a.data, a._hora).getTime();
  const J = janelasAtuais && janelasAtuais.get(a.data);
  if (J && J.ocupados.length) return Math.min(...J.ocupados.map((o) => o.ini));
  return spToDate(a.data, { h: 8, mi: 0 }).getTime();
}

function montarFrentes(now, ranking, materias, base, porUltimo) {
  const frentes = [];
  for (const sigla of SIGLAS) {
    const aula = proximaAula(sigla, now);
    materias[sigla].calc.proxima_aula = aula ? { inicio: aula.inicio, fim: aula.fim, titulo: aula.titulo } : null;
  }
  for (const r of ranking) {
    const sigla = r.sigla, m = materias[sigla], b = base[sigla];
    if (!m.tem_dados) continue;
    const ultimo = porUltimo.includes(sigla);
    const vphMat = m.calc.ganho_por_hora ?? (r.score / 100) * 0.1;
    // preparo
    for (const a of b.elegiveis || []) {
      const pr = a.preparo;
      if (!pr || !(pr.horas_restantes > 0)) continue;
      const prazo = prazoAvaliacao(a);
      if (prazo != null && prazo <= now.getTime()) continue;
      const peso = a.peso ?? (a.tipo.toLowerCase() === 'prova' ? 0.1 : 0.05);
      frentes.push({
        id: `preparo:${sigla}:${a.id}`, frente: 'preparo', materia: sigla, titulo: `Preparar ${curto(a.titulo)}`,
        avaliacao: { id: a.id, titulo: a.titulo }, min: pr.horas_restantes * 60, prazo,
        vph: (peso * 10) / pr.horas_restantes, ultimo, o_que: pr.o_que,
      });
    }
    // estudo
    const alvo = b.alvo;
    const need = m.calc.horas_restantes_calibradas ?? m.calc.horas_restantes;
    if (alvo && need > 0) {
      const prazo = alvo.data ? spToDate(alvo.data, alvo._hora || { h: 0, mi: 0 }).getTime() : null;
      if (prazo == null || prazo > now.getTime()) {
        frentes.push({
          id: `estudo:${sigla}`, frente: 'estudo', materia: sigla, titulo: `Estudar ${sigla}`,
          avaliacao: { id: alvo.id, titulo: alvo.titulo }, min: need * 60, prazo, vph: vphMat, ultimo,
          prova: alvo.tipo.toLowerCase() === 'prova', alvoData: alvo.data, alvo, peso: alvo.peso,
          topicos: (b.bloco || []).filter((t) => t.horas_restantes > 0)
            .map((t) => ({ id: t.id, nome: t.nome, conf: t.confianca ?? 0.5, dif: t.dificuldade ?? 3, h: t.horas_restantes }))
            .sort((x, y) => x.conf - y.conf),
          reserva: [...(b.bloco || [])].sort((x, y) => (x.confianca ?? 0.5) - (y.confianca ?? 0.5))[0] || null,
        });
      }
    }
    // triagem: aula nas proximas 36 h sem saber o que precisa
    const aula = proximaAula(sigla, now);
    if (!ultimo && aula && aula._ini - now.getTime() <= 36 * 3600000) {
      const diaAula = ymdSP(new Date(aula._ini));
      const semPreparo = (b.elegiveis || []).filter((a) => a.data && a.data <= diaAula && !a.preparo);
      const ref = parseISO(m.dados.atualizado_em) || parseISO(m.dados.recebido_em);
      const velho = !ref || now - ref > 24 * 3600000;
      const surgiu = aula._ini - 36 * 3600000;
      const estudou = sessoes.some((x) => x.materia === sigla && x.origem === 'timer' && parseISO(x.inicio) && parseISO(x.inicio).getTime() >= surgiu);
      if ((semPreparo.length || velho) && !estudou) {
        frentes.push({
          id: `triagem:${sigla}`, frente: 'triagem', materia: sigla,
          titulo: `Ver o que precisa para a aula de ${sigla} (${rotuloDia(aula._ini, now)}, ${hhmm(aula._ini)})`,
          avaliacao: semPreparo[0] ? { id: semPreparo[0].id, titulo: semPreparo[0].titulo } : null,
          min: TRIAGEM_MIN, prazo: aula._ini, vph: 0.2, ultimo, aula,
          motivoTriagem: semPreparo.length ? `${semPreparo.length === 1 ? 'tem 1 avaliação' : `tem ${semPreparo.length} avaliações`} até a aula sem plano de preparo` : 'os dados da matéria têm mais de 24 h',
        });
      }
    }
  }
  return frentes;
}

// Reserva de tras para frente: cada frente com prazo ocupa os blocos mais tardios antes do prazo.
function reservarFrentes(frentes, blocos, now) {
  const cap = blocos.map((bl) => bl.fim - bl.ini);
  const comPrazo = frentes.filter((f) => f.prazo != null && !f.ultimo).sort((a, b) => b.prazo - a.prazo);
  for (const f of comPrazo) {
    let need = f.min * 60000, inicio = null;
    for (let k = blocos.length - 1; k >= 0 && need > 0; k--) {
      const bl = blocos[k];
      if (bl.fim > f.prazo || cap[k] <= 0) continue;
      const take = Math.min(cap[k], need);
      cap[k] -= take; need -= take;
      inicio = bl.ini + cap[k];
    }
    f.cabe = need <= 0;
    f.faltam_min = f.cabe ? 0 : Math.ceil(need / 60000);
    f.inicio_mais_tarde = inicio;
    f._ims = f.cabe ? inicio : -Infinity; // nao cabe: critica desde ja
  }
  for (const f of frentes) {
    if (f.cabe === undefined) { f.cabe = true; f.faltam_min = 0; f.inicio_mais_tarde = null; f._ims = Infinity; }
  }
}

function porQue(f, now, critico) {
  if (f.frente === 'preparo') {
    return `${f.avaliacao ? curto(f.avaliacao.titulo) : 'a avaliação'} é ${rotuloQuando(f.prazo, now)} e faltam ${Math.round(f.rest)} min de preparo${critico ? ', é o prazo mais curto' : ''}`;
  }
  if (f.frente === 'triagem') return `aula ${rotuloQuando(f.prazo, now)} e ${f.motivoTriagem}`;
  const a = f.alvo;
  let t = a ? `${curto(a.titulo)} ${quando(a.dias_restantes)}` : 'sem avaliação marcada';
  if (f.peso != null) t += `, vale ${fmtPct(f.peso)}`;
  if (f.vph > 0) t += `, cada hora vale cerca de ${fmtNum(f.vph, 2)} ponto`;
  return t;
}

// Agenda: frentes, reserva e alocacao cronologica nos blocos dos proximos 7 dias.
function agendar(now, ranking, materias, base, porUltimo) {
  const { ok } = lerRotina();
  const J = [...janelasAtuais.values()];
  const todos = J.flatMap((d) => d.blocos.map((bl) => ({ ...bl, data: d.data }))).sort((a, b) => a.ini - b.ini);
  const frentes = montarFrentes(now, ranking, materias, base, porUltimo);
  reservarFrentes(frentes, todos, now);
  for (const f of frentes) { f.rest = f.min; f.porDia = {}; }
  const ordemRank = new Map(ranking.map((r, k) => [r.sigla, k]));
  const SEG_MIN = 15 * 60000;

  const dias = [];
  for (let i = 0; i < Math.min(PLANO_DIAS, J.length); i++) {
    const d = J[i];
    const itens = [];
    for (const o of d.ocupados) {
      if (i === 0 && o.fim <= now.getTime()) continue;
      itens.push({ tipo: 'ocupado', ini: o.ini, fim: o.fim, titulo: o.titulo, origem: o.origem, materia: null, topico: null, frente: null, avaliacao: null, critico: false });
    }
    const amanha = addDays(d.data, 1);
    const vesp = frentes.filter((f) => f.frente === 'estudo' && f.prova && !f.ultimo && f.alvoData === amanha);
    const seq = [];
    let ultimoUsado = false, segIdx = 0, primeiroEstudo = true;
    d.blocos.forEach((bl, kb) => {
      let t = bl.ini;
      const ultimoDoDia = kb === d.blocos.length - 1;
      while (bl.fim - t >= SEG_MIN || t === bl.ini) {
        const resto = bl.fim - t;
        const cabeNoPrazo = (f) => f.prazo == null || t + Math.min(f.rest * 60000, resto) <= f.prazo;
        const vivo = (f) => f.rest > 0.01 && cabeNoPrazo(f);
        const seguidas = (sig) => seq.length >= 2 && seq[seq.length - 1] === sig && seq[seq.length - 2] === sig;
        const triagemCritica = (f) => {
          if (f.frente !== 'triagem' || f.prazo - t >= DIA_MS) return false;
          const ultimoAntes = !todos.some((x) => x.ini > bl.ini && x.fim <= f.prazo);
          const vesperaUltimo = ymdSP(new Date(f.prazo)) === amanha && ultimoDoDia;
          return ultimoAntes || vesperaUltimo;
        };
        const critica = (f) => !f.ultimo && (f.frente === 'triagem' ? triagemCritica(f) : (f.prazo != null && t >= f._ims));
        const cands = frentes.filter((f) => !f.ultimo && vivo(f));
        let esc = null, crit = false;
        const crits = cands.filter(critica).sort((a, b) => a.prazo - b.prazo);
        if (crits.length) { esc = crits[0]; crit = true; }
        if (!esc && vesp.length && segIdx % 2 === 0) {
          const vs = vesp.filter((f) => vivo(f) && !seguidas(f.materia));
          if (vs.length) esc = vs[(segIdx / 2) % vs.length];
        }
        if (!esc) {
          let melhor = -1;
          for (const f of cands) {
            if (f.frente === 'triagem' && f.prazo - t >= DIA_MS) continue; // triagem so no dia anterior a aula
            if (seguidas(f.materia)) continue;
            const dias = f.prazo == null ? 30 : Math.max(0, (f.prazo - t) / DIA_MS);
            const idx = f.vph * (1 + 2 / (1 + dias)) * Math.pow(0.8, f.porDia[d.data] || 0);
            if (idx > melhor || (idx === melhor && ordemRank.get(f.materia) < ordemRank.get(esc.materia))) { melhor = idx; esc = f; }
          }
        }
        // preparo antes do estudo da mesma materia quando o prazo do preparo e em menos de 36 h
        if (esc && esc.frente === 'estudo') {
          const prep = frentes.find((f) => f.frente === 'preparo' && f.materia === esc.materia && vivo(f) && f.prazo != null && f.prazo - t < 36 * 3600000);
          if (prep) esc = prep;
        }
        if (!esc && !ultimoUsado) {
          esc = frentes.find((f) => f.ultimo && vivo(f)) || null;
          if (esc) ultimoUsado = true;
        }
        if (!esc) {
          if (resto >= SEG_MIN) itens.push({ tipo: 'estudo', ini: t, fim: bl.fim, titulo: 'Livre', origem: 'sugestao', materia: null, topico: null, frente: null, avaliacao: null, critico: false, _jan: `${d.data}#${bl.jan}` });
          seq.push(null);
          break;
        }
        let len = Math.min(esc.rest * 60000, resto);
        if (resto - len < SEG_MIN) len = resto; // sobra pequena fica no mesmo item
        const min = len / 60000;
        let topico = null;
        if (esc.frente === 'estudo') {
          const vivos = esc.topicos.filter((x) => x.h > 1e-9);
          if (vivos.length) {
            const tp = primeiroEstudo && horaSP(new Date(t)) < 12
              ? [...vivos].sort((x, y) => y.dif - x.dif || x.conf - y.conf)[0]
              : vivos[0];
            tp.h -= min / 60;
            topico = { id: tp.id, nome: tp.nome };
          } else if (esc.reserva) topico = { id: esc.reserva.id, nome: esc.reserva.nome };
          primeiroEstudo = false;
        }
        esc.rest -= min;
        esc.porDia[d.data] = (esc.porDia[d.data] || 0) + 1;
        const titulo = esc.frente === 'estudo' ? (topico ? `${esc.materia}: ${topico.nome}` : esc.materia) : esc.titulo;
        itens.push({
          tipo: 'estudo', ini: t, fim: t + len, titulo, origem: 'sugestao', materia: esc.materia, topico,
          frente: esc.frente, avaliacao: esc.avaliacao, critico: crit, _f: esc, _jan: `${d.data}#${bl.jan}`,
        });
        seq.push(esc.materia);
        segIdx++;
        t += len;
        if (t >= bl.fim) break;
      }
    });
    itens.sort((x, y) => x.ini - y.ini || (x.tipo === 'ocupado' ? -1 : 1));
    const fund = [];
    for (const it of itens) {
      const ant = fund[fund.length - 1];
      if (ant && it.tipo === 'ocupado' && ant.tipo === 'ocupado' && ant.titulo === it.titulo && it.ini <= ant.fim) {
        ant.fim = Math.max(ant.fim, it.fim);
      } else fund.push({ ...it });
    }
    dias.push({ data: d.data, dia_semana: d.dia_semana, estudo_min: Math.round(d.estudo_min), _itens: fund });
  }

  // fila: proxima janela livre contigua com trabalho
  const futuros = dias.flatMap((d) => d._itens).filter((it) => it.tipo === 'estudo' && it.fim > now.getTime());
  const chave = (futuros.find((it) => it.materia) || {})._jan;
  const daJanela = chave ? futuros.filter((it) => it._jan === chave) : [];
  let janela = null, fila = [];
  if (daJanela.length) {
    const ini = daJanela[0].ini, fim = daJanela[daJanela.length - 1].fim;
    const minutos = Math.round(daJanela.reduce((a, it) => a + (it.fim - it.ini), 0) / 60000);
    janela = { inicio: isoSP(new Date(ini)), fim: isoSP(new Date(fim)), minutos, rotulo: rotuloJanela(ini, fim, now) };
    // por_que usa o estado da frente no momento do item: recalcula o resto ate ali
    const restAte = new Map();
    for (const f of frentes) restAte.set(f, f.min);
    for (const it of dias.flatMap((d) => d._itens)) {
      if (!it._f) continue;
      if (daJanela.includes(it)) it._rest = restAte.get(it._f);
      restAte.set(it._f, restAte.get(it._f) - (it.fim - it.ini) / 60000);
    }
    fila = daJanela.filter((it) => it.materia).slice(0, 5).map((it) => ({
      frente: it.frente, materia: it.materia, titulo: it.titulo, topico: it.topico,
      minutos: Math.round((it.fim - it.ini) / 60000),
      inicio: isoSP(new Date(it.ini)),
      prazo: it._f && it._f.prazo != null ? isoSP(new Date(it._f.prazo)) : null,
      critico: it.critico, avaliacao: it.avaliacao,
      por_que: porQue({ ...it._f, rest: it._rest ?? it._f.rest }, now, it.critico),
    }));
  }

  const plano = {
    rotina_ok: ok,
    dias: dias.map((d) => ({
      data: d.data, dia_semana: d.dia_semana, estudo_min: d.estudo_min,
      itens: d._itens.map((it) => ({
        tipo: it.tipo, inicio: isoSP(new Date(it.ini)), fim: isoSP(new Date(it.fim)), titulo: it.titulo,
        origem: it.origem, materia: it.materia, topico: it.topico,
        frente: it.frente, avaliacao: it.avaliacao, critico: !!it.critico,
      })),
    })),
  };
  const frentesOut = frentes.map((f) => ({
    id: f.id, frente: f.frente, materia: f.materia, titulo: f.titulo, avaliacao: f.avaliacao,
    horas: rnd(f.min / 60, 2), prazo: f.prazo != null ? isoSP(new Date(f.prazo)) : null,
    inicio_mais_tarde: f.inicio_mais_tarde != null ? isoSP(new Date(f.inicio_mais_tarde)) : null,
    cabe: f.cabe, faltam_min: f.faltam_min, valor_por_hora: rnd(f.vph, 3), por_ultimo: f.ultimo,
    o_que: f.o_que ?? null,
  }));
  return { plano, frentes: frentesOut, fila, janela };
}

// ---------------------------------------------------------------- horas livres ate a prova

function horasDia(ymd) { return isWeekend(ymd) ? config.horas_dia_fds : config.horas_dia_semana; }
// Dia util de estudo considerado: 9h as 23h (14 h de janela). Hoje conta so o que sobra da janela.
function horasLivresAte(hoje, horaAgora, dias, hora, now) {
  if (dias == null || dias < 0) return null;
  if (janelasAtuais && now) {
    let total = 0;
    for (let i = 0; i <= dias; i++) {
      const d = addDays(hoje, i);
      if (i === dias && !hora) break; // sem hora, o dia da prova nao conta
      const J = janelasAtuais.get(d);
      if (J) {
        const lim = i === dias ? spToDate(d, hora).getTime() : Infinity;
        total += J.blocos.filter((bl) => bl.fim <= lim).reduce((a, bl) => a + (bl.fim - bl.ini), 0) / 3600000;
      } else {
        total += i === dias ? horasDia(d) * clamp((hora.h + hora.mi / 60 - 9) / 14, 0, 1) : horasDia(d);
      }
    }
    return total;
  }
  const JAN_INI = 9, JAN = 14;
  if (dias === 0) {
    const fim = hora ? hora.h + hora.mi / 60 : 23;
    return horasDia(hoje) * clamp((fim - Math.max(horaAgora, JAN_INI)) / JAN, 0, 1);
  }
  let total = horasDia(hoje) * clamp((23 - Math.max(horaAgora, JAN_INI)) / JAN, 0, 1);
  for (let i = 1; i < dias; i++) total += horasDia(addDays(hoje, i));
  if (hora) {
    const dia = addDays(hoje, dias);
    total += horasDia(dia) * clamp((hora.h + hora.mi / 60 - JAN_INI) / JAN, 0, 1);
  }
  return total;
}

// ---------------------------------------------------------------- State

function configOut(now) {
  const aj = ajusteValido(now);
  return {
    horas_dia_semana: config.horas_dia_semana, horas_dia_fds: config.horas_dia_fds,
    dorme_hoje: aj ? aj.dorme : null, acorda_amanha: aj ? aj.acorda : null,
    ajuste_valido_ate: aj ? config.ajuste_valido_ate : null,
    rotina: (() => { const r = lerRotina().rotina; const f = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; return { acorda: f(r.acorda), dorme: f(r.dorme) }; })(),
  };
}
function agoraServidor() {
  const f = process.env.PAINEL_AGORA ? parseISO(process.env.PAINEL_AGORA) : null; // so para teste
  return f || new Date();
}

function computeState(now = agoraServidor()) {
  janelasAtuais = calcularJanelas(now);
  const hoje = ymdSP(now);
  const horaAgora = horaSP(now);
  const inicioSemana = addDays(hoje, -((weekday(hoje) + 6) % 7));

  // passo 1: normaliza cada materia
  const marcas = lerMarcas();
  const base = {};
  for (const sigla of SIGLAS) {
    const dados = carregarMateria(sigla);
    const b = { sigla, dados };
    base[sigla] = b;
    if (!dados) continue;
    b.avaliacoes = arr(dados.avaliacoes).map((a, i) => normAvaliacao(a, i, hoje)).filter(Boolean);
    for (const a of b.avaliacoes) {
      const mk = marcas[`${sigla}:${a.id}`];
      if (!mk || !PENDENTE(a.status)) continue;
      a.marca = mk.estado;
      if (mk.estado === 'entregue') a.status = 'entregue';
      else a.preparo = { o_que: null, checklist: [], ...(a.preparo || {}), horas_restantes: 0 };
    }
    b.topicos = arr(dados.topicos).map(normTopico).filter(Boolean);
    for (const t of b.topicos) t.confianca = confiancaTopico(t, hoje);
    const pend = b.avaliacoes.filter((a) => PENDENTE(a.status));
    const futuras = pend
      .filter((a) => a.data && a.dias_restantes >= 0)
      .filter((a) => !(a.dias_restantes === 0 && a._hora && spToDate(a.data, a._hora) < new Date(now.getTime() - 3 * 3600000)))
      .sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : (x.hora || '99') < (y.hora || '99') ? -1 : 1));
    b.pendentesFuturas = futuras;
    b.proxima = futuras[0] || pend.find((a) => !a.data) || null;
    const semData = pend.filter((a) => !a.data);
    b.pendentes = [...futuras, ...semData];

    // horas de estudo ligadas a cada avaliacao (soma dos topicos ligados)
    const porId = new Map(b.topicos.map((t) => [t.id, t]));
    for (const a of b.avaliacoes) {
      a._ligados = a.topicos.map((id) => porId.get(id)).filter(Boolean);
      a._horasLigadas = a._ligados.reduce((acc, t) => acc + (t.horas_restantes > 0 ? t.horas_restantes : 0), 0);
      a._exigeEstudo = a.tipo.toLowerCase() === 'prova' || a._horasLigadas > 0;
    }
    // avaliacoes elegiveis: pendentes e nao contingentes
    const elegiveis = b.pendentes.filter((a) => !contingente(a));
    b.elegiveis = elegiveis;
    const ehProva = (a) => a.tipo.toLowerCase() === 'prova';
    // avaliacao decisiva: maior urgencia x peso
    let melhor = null;
    for (const a of elegiveis) {
      const u = a.dias_restantes != null ? 1 / (1 + Math.max(0, a.dias_restantes) / 4) : 0.15;
      const p = a.peso != null ? a.peso : ehProva(a) ? 0.3 : 0.05;
      const valor = u * (0.1 + 0.9 * p);
      if (!melhor || valor > melhor.valor) melhor = { a, u, p, valor };
    }
    b.decisiva = melhor;
    // alvo de estudo: proxima prova com data; sem prova pendente, a de maior valor
    // entre as provas com data, a de maior urgencia x peso (prova sem peso declarado pesa pouco: 0.1)
    let provaAlvo = null, vAlvo = -1;
    for (const a of elegiveis) {
      if (!ehProva(a) || !a.data || a.dias_restantes == null) continue;
      const v = (1 / (1 + Math.max(0, a.dias_restantes) / 4)) * (0.1 + 0.9 * (a.peso != null ? a.peso : 0.1));
      if (v > vAlvo) { vAlvo = v; provaAlvo = a; }
    }
    b.alvo = provaAlvo
      || elegiveis.find(ehProva)
      || (melhor ? melhor.a : null);
  }

  // passo 2: calculos por materia
  const materias = {};
  const fatoresPorSigla = {};
  for (const sigla of SIGLAS) {
    const b = base[sigla];
    const d = b.dados;
    const estudo = estudoMateria(sigla, hoje, inicioSemana);
    if (!d) {
      estudo.sem_topico_min = tempoPorTopico(sigla, []).sem;
      materias[sigla] = {
        sigla, nome: sigla, tem_dados: false, atualizado_em: null, recebido_em: null, desatualizado: false,
        dados: null,
        calc: {
          proxima_avaliacao: null, alvo_estudo: null, simulado: null, tempo_por_topico: {}, ritmo: null, horas_restantes_calibradas: null,
          nota_projetada: null, margem: null, nota_projetada_motivo: 'sem dado', garantido: null, em_jogo: null, nota_necessaria_origem: null, ganho_por_hora: null, progresso: null, confianca: null, confianca_rotulo: 'sem dado',
          exercicios_feitos: null, exercicios_certos: null, horas_restantes: null,
          horas_disponiveis_ate_prova: null, folga_h: null, nota_atual: null, nota_necessaria: null,
          topicos_fracos: [],
        },
        estudo,
      };
      continue;
    }
    const atualizado = parseISO(d.atualizado_em);
    const recebido = parseISO(d.recebido_em);
    const ref = atualizado || recebido;
    const desatualizado = ref ? now - ref > 48 * 3600000 : true;

    const prox = b.proxima;
    let proxima_avaliacao = null;
    if (prox) {
      let hAte = null;
      if (prox.data) hAte = Math.max(0, (spToDate(prox.data, prox._hora) - now) / 3600000);
      proxima_avaliacao = {
        id: prox.id, titulo: prox.titulo, tipo: prox.tipo, data: prox.data, hora: prox.hora,
        dias_restantes: prox.dias_restantes, horas_restantes_ate_la: rnd(hAte), confirmada: prox.confirmada,
      };
    }

    // bloco atual: topicos ligados a avaliacao alvo de estudo
    const alvo = b.alvo;
    let bloco = alvo ? alvo._ligados : [];
    const usaLigados = bloco.length > 0;
    if (!bloco.length) bloco = b.topicos.filter((t) => (t.bloco || '').toUpperCase() === 'P2');
    if (!bloco.length) bloco = b.topicos;
    b.bloco = bloco;
    const alvo_estudo = alvo
      ? { id: alvo.id, titulo: alvo.titulo, tipo: alvo.tipo, data: alvo.data, dias_restantes: alvo.dias_restantes }
      : null;

    let sw = 0, sc = 0;
    for (const t of bloco) {
      if (t.confianca == null) continue;
      const w = t.dificuldade != null && t.dificuldade > 0 ? t.dificuldade : 1;
      sw += w; sc += w * t.confianca;
    }
    const confExerc = sw > 0 ? sc / sw : null;

    // simulado mais recente do alvo
    let simulado = null;
    if (alvo) {
      const sims = arr(d.simulados).map(obj).filter(Boolean)
        .filter((x) => str(x.avaliacao) === alvo.id)
        .map((x) => ({ nota: num(x.nota), max: num(x.max) ?? 10, data: parseYmd(x.data) }))
        .filter((x) => x.nota != null && x.max > 0 && x.nota >= 0)
        .sort((x, y) => (y.data || '').localeCompare(x.data || ''));
      if (sims.length) simulado = sims[0];
    }
    let confianca = confExerc;
    if (simulado) {
      const fr = clamp(simulado.nota / simulado.max, 0, 1);
      confianca = confExerc != null ? 0.6 * fr + 0.4 * confExerc : fr;
    }
    const rotulo = confianca == null ? 'sem dado' : confianca < 0.4 ? 'baixa' : confianca < 0.7 ? 'média' : 'alta';

    const comStatus = bloco.filter((t) => t.status);
    const progresso = comStatus.length ? comStatus.filter((t) => t.status === 'dominado').length / comStatus.length : null;

    let feitos = null, certos = null;
    for (const t of b.topicos) {
      if (t.feitos != null) feitos = (feitos || 0) + Math.max(0, t.feitos);
      if (t.certos != null) certos = (certos || 0) + Math.max(0, t.certos);
    }

    const hs = bloco.map((t) => t.horas_restantes).filter((x) => x != null);
    let horas_restantes = hs.length ? hs.reduce((a, x) => a + Math.max(0, x), 0) : null;
    if (horas_restantes == null && !usaLigados) horas_restantes = num(d.horas_restantes_total);
    if (horas_restantes != null) horas_restantes = Math.max(0, horas_restantes);

    // ritmo medido: snapshots diarios do historico para o mesmo alvo
    const tpt = tempoPorTopico(sigla, b.topicos);
    estudo.sem_topico_min = tpt.sem;
    const ritmo = ritmoTopicos(b.topicos, tpt.tempo) || calcRitmo(sigla, alvo);
    const horas_cal = ritmo && horas_restantes != null ? horas_restantes * ritmo.fator : null;
    const horas_uso = horas_cal != null ? horas_cal : horas_restantes;

    let horas_disp = null;
    if (alvo && alvo.data && alvo.dias_restantes >= 0) {
      const bruto = horasLivresAte(hoje, horaAgora, alvo.dias_restantes, alvo._hora, now);
      let concorrentes = 0;
      for (const s2 of SIGLAS) {
        const a2 = base[s2].dados ? base[s2].alvo : null;
        if (a2 && a2.data && a2.dias_restantes >= 0 && a2.dias_restantes <= alvo.dias_restantes) concorrentes++;
      }
      horas_disp = bruto / Math.max(1, concorrentes);
    }
    const folga = horas_disp != null && horas_uso != null ? horas_disp - horas_uso : null;

    // notas
    let sp = 0, spn = 0, ss = 0, ns = 0;
    for (const nt of arr(d.notas)) {
      const o = obj(nt);
      if (!o) continue;
      const nota = num(o.nota);
      if (nota == null) continue;
      const max = num(o.max);
      const n10 = max != null && max > 0 ? (nota / max) * 10 : nota;
      ss += n10; ns++;
      const p = normPeso(o.peso);
      if (p != null && p > 0) { sp += p; spn += p * n10; }
    }
    const nota_atual = sp > 0 ? spn / sp : ns ? ss / ns : null;
    const nn = obj(d.nota_necessaria);
    const nota_nec_sessao = nn ? num(nn.valor) : num(d.nota_necessaria);
    const media_aprov = num(d.media_aprovacao) ?? MEDIA_PADRAO;

    // nota projetada: lancadas com peso + pendentes elegiveis com nota = 10 x confianca do bloco
    let nota_projetada = null, motivoSemProj = null;
    {
      let somaP = 0, somaPN = 0, falta = false;
      for (const nt of arr(d.notas)) {
        const o = obj(nt);
        if (!o) continue;
        const nota = num(o.nota), pz = normPeso(o.peso);
        if (nota == null) continue;
        if (pz == null) { falta = true; motivoSemProj = 'nota lançada sem peso'; break; }
        const max = num(o.max);
        somaP += pz; somaPN += pz * (max != null && max > 0 ? (nota / max) * 10 : nota);
      }
      if (!falta) {
        for (const a of b.elegiveis) {
          if (a.peso == null) { falta = true; motivoSemProj = `${curto(a.titulo, 24)} sem peso`; break; }
          let cf;
          if (a === alvo) cf = confianca;
          else if (a._ligados.length) cf = mediaConf(a._ligados);
          else cf = confianca;
          if (cf == null) { falta = true; motivoSemProj = 'sem confiança para projetar'; break; }
          somaP += a.peso; somaPN += a.peso * 10 * cf;
        }
      }
      if (!falta) {
        if (Math.abs(somaP - 1) > 0.05) motivoSemProj = `pesos conhecidos somam ${fmtNum(somaP * 100, 0)}%`;
        else nota_projetada = somaPN / somaP;
      }
    }
    // composicao enviada pela sessao (pesos efetivos na media final): tem prioridade
    const comp = projetarComposicao(d, b, alvo, confianca, media_aprov);
    let garantido = null, em_jogo = null, nota_necessaria = nota_nec_sessao;
    let nota_necessaria_origem = nota_nec_sessao != null ? 'sessao' : null;
    if (comp.valida) {
      garantido = comp.garantido;
      em_jogo = comp.em_jogo;
      nota_projetada = comp.nota_projetada;
      motivoSemProj = comp.motivo;
      if (nota_nec_sessao == null && comp.nota_necessaria != null) {
        nota_necessaria = comp.nota_necessaria;
        nota_necessaria_origem = 'painel';
      }
    } else if (comp.motivo) {
      motivoSemProj = nota_projetada == null ? comp.motivo : motivoSemProj;
    }
    const margem = nota_projetada != null ? nota_projetada - media_aprov : null;

    // ganho por hora no alvo
    const ganho_por_hora = alvo && alvo.peso != null && confianca != null
      ? (alvo.peso * 10 * (1 - confianca)) / Math.max(horas_uso != null ? horas_uso : 1, 1)
      : null;

    const fracos = bloco
      .filter((t) => t.confianca != null && t.status !== 'dominado')
      .sort((x, y) => x.confianca - y.confianca)
      .slice(0, 3)
      .map((t) => ({ id: t.id, nome: t.nome, confianca: rnd(t.confianca, 3), horas_restantes: t.horas_restantes }));

    // fatores
    const urgencia = b.decisiva ? b.decisiva.u : 0.15;
    const peso = b.decisiva ? b.decisiva.p : 0.3;
    const lacuna = confianca != null ? 1 - confianca : 0.5;
    let carga = 0;
    if (horas_uso != null && horas_disp != null) {
      carga = horas_disp <= 0 ? (horas_uso > 0 ? 1 : 0) : clamp(horas_uso / horas_disp, 0, 1.5) / 1.5;
    }
    let risco = 0;
    if (margem != null) {
      risco = 1 / (1 + Math.exp(RISCO_K * margem));
    } else {
      const media = media_aprov;
      if (nota_necessaria != null) risco = Math.max(risco, clamp((nota_necessaria - 7) / 3, 0, 1));
      if (nota_atual != null && nota_atual < media) risco = Math.max(risco, clamp((media - nota_atual) / 3, 0, 1));
    }
    let score = 100 * (0.30 * urgencia + 0.15 * peso + 0.15 * lacuna + 0.15 * carga + 0.25 * risco);
    if (folga != null && folga < 0) score += Math.min(10, 2 * -folga);
    fatoresPorSigla[sigla] = {
      score: clamp(score, 0, 100),
      fatores: { urgencia: rnd(urgencia, 3), peso: rnd(peso, 3), lacuna: rnd(lacuna, 3), carga: rnd(carga, 3), risco_nota: rnd(risco, 3) },
    };

    const dadosOut = { ...d };
    materias[sigla] = {
      sigla,
      nome: str(d.nome) || sigla,
      tem_dados: true,
      atualizado_em: str(d.atualizado_em),
      recebido_em: str(d.recebido_em),
      desatualizado,
      dados: dadosOut,
      calc: {
        proxima_avaliacao,
        alvo_estudo,
        progresso: rnd(progresso, 3),
        confianca: rnd(confianca, 3),
        confianca_rotulo: rotulo,
        exercicios_feitos: feitos,
        exercicios_certos: certos,
        horas_restantes: rnd(horas_restantes),
        horas_restantes_calibradas: rnd(horas_cal),
        tempo_por_topico: tpt.tempo,
        ritmo,
        simulado: simulado ? { nota: simulado.nota, max: simulado.max, data: simulado.data } : null,
        nota_projetada: rnd(nota_projetada, 2),
        margem: rnd(margem, 2),
        nota_projetada_motivo: motivoSemProj,
        garantido: rnd(garantido, 2),
        em_jogo: rnd(em_jogo, 3),
        nota_necessaria_origem,
        ganho_por_hora: rnd(ganho_por_hora, 3),
        horas_disponiveis_ate_prova: rnd(horas_disp),
        folga_h: rnd(folga),
        nota_atual: rnd(nota_atual, 2),
        nota_necessaria: rnd(nota_necessaria, 2),
        topicos_fracos: fracos,
      },
      estudo,
    };
  }

  // ranking
  const ranking = SIGLAS.map((sigla) => {
    const m = materias[sigla];
    if (!m.tem_dados) {
      const f = { urgencia: 0.15, peso: 0.3, lacuna: 0.5, carga: 0, risco_nota: 0 };
      const sc = 100 * (0.30 * f.urgencia + 0.15 * f.peso + 0.15 * f.lacuna);
      return { sigla, score: rnd(sc), fatores: f, resumo: 'Sem dado enviado ainda.' };
    }
    const fx = fatoresPorSigla[sigla];
    return { sigla, score: rnd(fx.score), fatores: fx.fatores, resumo: resumoMateria(m, base[sigla]) };
  }).sort((a, b) => b.score - a.score
    || (materias[b.sigla].calc.ganho_por_hora ?? -1) - (materias[a.sigla].calc.ganho_por_hora ?? -1)
    || SIGLAS.indexOf(a.sigla) - SIGLAS.indexOf(b.sigla));
  // materias marcadas para ficar por ultimo (data/por_ultimo.json, lista de siglas)
  const porUltimo = lerPorUltimo();
  if (porUltimo.length) {
    ranking.sort((a, b) => porUltimo.includes(a.sigla) - porUltimo.includes(b.sigla));
    for (const r of ranking) if (porUltimo.includes(r.sigla)) r.resumo = 'Você marcou como baixa prioridade. ' + r.resumo;
  }

  const padraoFull = calcPadrao(now);
  const { _score, ...padrao } = padraoFull;

  const ag = agendar(now, ranking, materias, base, porUltimo);
  const plano = ag.plano;
  const recomendacao = recomendar(ranking.filter((r) => !porUltimo.includes(r.sigla)), materias, base, padrao, now, plano, ag);
  const agenda = montarAgenda(base);
  const estudo = estudoGeral(hoje, inicioSemana);
  const alertas = montarAlertas(materias, base, now);
  for (const f of ag.frentes) {
    if (f.cabe || f.por_ultimo || !f.prazo) continue;
    const acao = f.frente === 'preparo' ? `preparar ${curto(f.avaliacao ? f.avaliacao.titulo : f.titulo)}`
      : f.frente === 'triagem' ? `ver o que precisa para a aula de ${f.materia}` : `estudar ${f.materia} para ${curto(f.avaliacao ? f.avaliacao.titulo : '')}`;
    alertas.unshift({ nivel: 'critico', materia: f.materia, texto: `Faltam ${f.faltam_min} min de tempo livre para ${acao} até ${rotuloQuando(parseISO(f.prazo).getTime(), now)}.` });
  }

  return {
    agora: isoSP(now),
    config: configOut(now),
    timer: timerOut(),
    recomendacao,
    ranking,
    materias,
    agenda,
    estudo,
    padrao,
    alertas,
    calendario: calendarioState(now),
    plano,
    frentes: ag.frentes,
    disciplinas: DISCIPLINAS,
    tarefas: lerTarefas().filter((t) => !t.feito || String(t.feito_em || '').slice(0, 10) === hoje)
      .map((t) => ({ ...t, dias_restantes: t.data ? dayDiff(hoje, t.data) : null })),
  };
}

function resumoMateria(m, b) {
  const c = m.calc;
  const p = [];
  const dec = b.decisiva ? b.decisiva.a : null;
  if (dec) {
    let t = `${curto(dec.titulo)} ${quando(dec.dias_restantes)}`;
    if (dec.peso != null) t += `, vale ${fmtPct(dec.peso)}`;
    p.push(t);
  } else {
    p.push('Sem avaliação pendente');
  }
  if (b.alvo && b.alvo !== dec) p.push(`estudo mira ${curto(b.alvo.titulo)} ${quando(b.alvo.dias_restantes)}`);
  p.push(c.confianca == null ? 'confiança sem dado' : `confiança ${c.confianca_rotulo} (${fmtPct(c.confianca)})`);
  if (c.nota_projetada != null && c.margem != null) {
    p.push(`média projetada ${fmtNum(c.nota_projetada)} (margem ${c.margem >= 0 ? '+' : ''}${fmtNum(c.margem)})`);
  }
  if (c.folga_h != null && c.folga_h < 0) p.push(`atrasada ${fmtNum(-c.folga_h)} h`);
  return `${p.join(', ')}.`;
}

// Entregas/apresentacoes sem conteudo de estudo que vencem em ate 2 dias.
function acoesProximas(b) {
  return (b.pendentesFuturas || []).filter((a) => !a._exigeEstudo && a.dias_restantes <= 2);
}

function recomendar(ranking, materias, base, padrao, now = new Date(), plano = null, ag = null) {
  const comDado = ranking.filter((r) => materias[r.sigla].tem_dados);
  let top = comDado[0];
  const fila = ag ? ag.fila : [];
  const filaTop = fila.length ? comDado.find((r) => r.sigla === fila[0].materia) : null;
  let fraseGanho = '';
  // bloco do plano em andamento ou comecando em ate 10 min
  const T = (x) => parseISO(x).getTime();
  const itensHoje = plano && plano.dias[0] ? plano.dias[0].itens : [];
  const blocoPlano = itensHoje.find((it) => it.tipo === 'estudo' && it.materia
    && T(it.inicio) - now.getTime() <= 10 * 60000 && T(it.fim) > now.getTime()
    && comDado.some((r) => r.sigla === it.materia));
  if (blocoPlano) top = comDado.find((r) => r.sigla === blocoPlano.materia);
  if (filaTop) top = filaTop;
  let fraseLivre = '';
  if (!blocoPlano && plano) {
    const ocupadoAgora = itensHoje.find((it) => it.tipo === 'ocupado' && T(it.inicio) <= now.getTime() && T(it.fim) > now.getTime());
    if (ocupadoAgora) {
      let prox = null;
      for (const dia of plano.dias) {
        prox = dia.itens.find((it) => it.tipo === 'estudo' && T(it.inicio) > now.getTime());
        if (prox) break;
      }
      if (prox) {
        const dia = prox.inicio.slice(0, 10), hh = prox.inicio.slice(11, 16);
        const d = dayDiff(ymdSP(now), dia);
        fraseLivre = ` Agora é ${curto(ocupadoAgora.titulo, 24)}; próximo bloco livre ${d === 0 ? '' : d === 1 ? 'amanhã ' : `em ${fmtData(dia)} `}às ${hh}.`;
      }
    }
  }
  if (top && !blocoPlano && !filaTop) {
    // desempate: entre as que estao a ate 3 pontos do topo, vence o maior ganho por hora
    const empatadas = comDado.filter((r) => top.score - r.score <= 3);
    const g = (r) => materias[r.sigla].calc.ganho_por_hora;
    if (empatadas.length > 1 && empatadas.some((r) => g(r) != null)) {
      top = [...empatadas].sort((x, y) => (g(y) ?? -1) - (g(x) ?? -1))[0];
      const outros = empatadas.filter((r) => r !== top).map((r) => r.sigla).join(' e ');
      if (g(top) != null) {
        const v = g(top);
        fraseGanho = ` Empate técnico com ${outros}: cada hora aqui vale cerca de ${fmtNum(v, 2)} ${v >= 2 ? 'pontos' : 'ponto'} na média.`;
      }
    }
  }
  if (!top) {
    return {
      materia: null, topico: null,
      motivo: 'Nenhuma matéria mandou dado ainda. Sem dado, não dá pra priorizar.',
      proximo_passo: null, bloco_sugerido_min: 50, alternativa: null,
      frente: null, avaliacao: null, fila: [], janela: null,
    };
  }
  const m = materias[top.sigla], c = m.calc, b = base[top.sigla];
  const usaHora = padrao.amostra_suficiente && padrao.agora_e_boa_hora != null;

  // escolha do topico
  let cand = (b.bloco || []).filter((t) => t.status !== 'dominado');
  if (!cand.length) cand = b.bloco || [];
  let topico = null, fraseTopico = '';
  if (cand.length) {
    const conf = (t) => (t.confianca == null ? 0.5 : t.confianca);
    const dif = (t) => (t.dificuldade == null ? 3 : t.dificuldade);
    let escolhido;
    if (usaHora && padrao.agora_e_boa_hora === true) {
      escolhido = [...cand].sort((x, y) => dif(y) - dif(x) || conf(x) - conf(y))[0];
      fraseTopico = ' Hora boa no seu histórico, então vai no tópico mais difícil.';
    } else if (usaHora && padrao.agora_e_boa_hora === false) {
      escolhido = [...cand].sort((x, y) => dif(x) - dif(y) || conf(x) - conf(y))[0];
      fraseTopico = ' Hora fraca no seu histórico, então começa pelo tópico mais leve.';
    } else {
      escolhido = [...cand].sort((x, y) => conf(x) - conf(y))[0];
      if (escolhido.confianca != null) fraseTopico = ` Começa por ${escolhido.nome}, o tópico mais fraco (${fmtPct(escolhido.confianca)}).`;
    }
    topico = { id: escolhido.id, nome: escolhido.nome };
  }
  if (blocoPlano) {
    topico = blocoPlano.topico;
    fraseTopico = '';
  }

  const p = [];
  const alvo = b.alvo;
  if (alvo) {
    let s = `${curto(alvo.titulo)} de ${top.sigla} ${quando(alvo.dias_restantes)}`;
    if (alvo.peso != null) s += `, vale ${fmtPct(alvo.peso)} da média`;
    p.push(`${s}.`);
  } else {
    p.push(`${top.sigla} lidera com score ${fmtNum(top.score, 0)}.`);
  }
  if (c.confianca != null) p.push(`Confiança no bloco em ${fmtPct(c.confianca)}.`);
  if (c.folga_h != null && c.folga_h < 0) {
    p.push(`Faltam ${fmtNum(c.horas_restantes)} h de estudo e só há ${fmtNum(c.horas_disponiveis_ate_prova)} h livres até lá.`);
  }
  const acoes = acoesProximas(b);
  if (acoes.length) {
    const a = acoes[0];
    let s = `Não esquece de ${verboAcao(a)} ${curto(a.titulo, 30)} ${quando(a.dias_restantes)}`;
    if (acoes.length > 1) s += ` e mais ${acoes.length - 1} ${acoes.length === 2 ? 'entrega' : 'entregas'} até ${fmtData(acoes[acoes.length - 1].data)}`;
    p.push(`${s}.`);
  }
  let bloco_min = 50;
  if (usaHora) bloco_min = padrao.agora_e_boa_hora ? 75 : 30;
  let fraseEvento = '';
  const ev = cal.ok ? proximoEvento(now) : null;
  if (ev) {
    const ate = Math.floor((ev._ini - now.getTime()) / 60000);
    if (ate < bloco_min) {
      bloco_min = Math.max(20, Math.floor(ate / 5) * 5);
      const hh = ev.inicio.slice(11, 16);
      fraseEvento = ate >= 20
        ? ` Você tem ${curto(ev.titulo, 30)} às ${hh}, então o bloco é de ${bloco_min} min.`
        : ` Você tem ${curto(ev.titulo, 30)} às ${hh}, sobra pouco tempo antes.`;
    }
  }
  if (blocoPlano) {
    bloco_min = Math.max(20, Math.round((T(blocoPlano.fim) - now.getTime()) / 60000));
    fraseEvento = '';
    p.unshift(`Bloco do plano até ${blocoPlano.fim.slice(11, 16)}${blocoPlano.topico ? `: ${blocoPlano.topico.nome}` : ''}.`);
  }
  let motivo = p.join(' ') + fraseGanho + fraseTopico + fraseEvento + fraseLivre;
  let frente = 'estudo';
  let avaliacao = b.alvo ? { id: b.alvo.id, titulo: b.alvo.titulo } : null;
  if (filaTop) {
    const f0 = fila[0];
    const ini0 = parseISO(f0.inicio).getTime();
    frente = f0.frente;
    avaliacao = f0.avaliacao;
    topico = f0.topico;
    const fim0 = ini0 + f0.minutos * 60000;
    bloco_min = ini0 - now.getTime() <= 10 * 60000 ? Math.max(20, Math.round((fim0 - now.getTime()) / 60000)) : f0.minutos;
    const ordem = fila.map((x, k) => `${k === 0 ? 'Primeiro' : k === fila.length - 1 && k > 1 ? 'Por fim' : 'Depois'}, ${x.titulo} (${x.minutos} min): ${x.por_que}.`);
    motivo = `Próxima janela: ${ag.janela.rotulo} (${ag.janela.minutos} min). ${ordem.join(' ')}${fraseLivre}`;
  }

  let alternativa = null;
  if (m.estudo.hoje_min > 120) {
    const seg = ranking.find((r) => r.sigla !== top.sigla && materias[r.sigla].tem_dados);
    if (seg) {
      alternativa = {
        materia: seg.sigla,
        motivo: `${top.sigla} já teve ${fmtMin(m.estudo.hoje_min)} hoje. ${seg.sigla} é a segunda da fila (score ${fmtNum(seg.score, 0)}).`,
      };
    }
  }
  return {
    materia: top.sigla,
    topico,
    motivo,
    proximo_passo: str(m.dados.proximo_passo),
    bloco_sugerido_min: bloco_min,
    alternativa,
    frente,
    avaliacao,
    fila,
    janela: ag ? ag.janela : null,
  };
}

function montarAgenda(base) {
  const out = [];
  for (const sigla of SIGLAS) {
    const b = base[sigla];
    if (!b.dados) continue;
    for (const a of b.avaliacoes) {
      const futura = a.dias_restantes != null && a.dias_restantes >= 0;
      if (!futura && !PENDENTE(a.status)) continue;
      out.push({
        materia: sigla, id: a.id, titulo: a.titulo, tipo: a.tipo, data: a.data, hora: a.hora,
        dias_restantes: a.dias_restantes, peso: a.peso, status: a.status, confirmada: a.confirmada,
        marca: a.marca || null, preparo_h: a.preparo ? a.preparo.horas_restantes : null,
      });
    }
  }
  return out.sort((x, y) => {
    if (x.data == null && y.data == null) return 0;
    if (x.data == null) return 1;
    if (y.data == null) return -1;
    if (x.data !== y.data) return x.data < y.data ? -1 : 1;
    return (x.hora || '99') < (y.hora || '99') ? -1 : (x.hora || '99') > (y.hora || '99') ? 1 : 0;
  });
}

function montarAlertas(materias, base, now) {
  const al = [];
  for (const sigla of SIGLAS) {
    const m = materias[sigla], b = base[sigla];
    if (!m.tem_dados) { al.push({ nivel: 'info', materia: sigla, texto: `${sigla} ainda não mandou dado.` }); continue; }
    if (m.desatualizado) {
      const ref = parseISO(m.atualizado_em) || parseISO(m.recebido_em);
      const dias = ref ? Math.floor((now - ref) / 86400000) : null;
      al.push({
        nivel: 'atencao', materia: sigla,
        texto: dias != null ? `${sigla} está sem atualização há ${dias} ${dias === 1 ? 'dia' : 'dias'}.` : `${sigla} mandou dado sem data de atualização.`,
      });
    }
    const naoConf = [];
    for (const a of b.pendentesFuturas) {
      const quandoTxt = `${quando(a.dias_restantes)} (${fmtData(a.data)}${a.hora ? ` às ${a.hora}` : ''})`;
      if (a._exigeEstudo && a.dias_restantes <= 3) {
        al.push({ nivel: a.dias_restantes <= 1 ? 'critico' : 'atencao', materia: sigla, texto: `${curto(a.titulo)} de ${sigla} ${quandoTxt}.` });
      } else if (!a._exigeEstudo && a.dias_restantes <= 2) {
        const v = verboAcao(a);
        al.push({
          nivel: a.dias_restantes <= 1 ? 'critico' : 'atencao', materia: sigla,
          texto: `${v[0].toUpperCase()}${v.slice(1)} ${curto(a.titulo)} de ${sigla} ${quandoTxt}.`,
        });
      }
      if (a.confirmada === false) naoConf.push(a);
    }
    if (naoConf.length) {
      const itens = naoConf.slice(0, 2).map((a) => `${curto(a.titulo, 24)} em ${fmtData(a.data)}`);
      const resto = naoConf.length > 2 ? ` e mais ${naoConf.length - 2}` : '';
      al.push({
        nivel: 'info', materia: sigla,
        texto: naoConf.length === 1
          ? `${sigla}: data não confirmada de ${itens[0]}.`
          : `${sigla}: ${naoConf.length} datas não confirmadas (${itens.join(', ')}${resto}).`,
      });
    }
    const f = m.calc.folga_h;
    if (f != null && f < 0 && b.alvo) {
      al.push({
        nivel: 'atencao', materia: sigla,
        texto: `${sigla} está ${fmtNum(-f)} h atrasada para ${curto(b.alvo.titulo)} ${quando(b.alvo.dias_restantes)}.`,
      });
    }
  }
  if (timer) {
    const ini = parseISO(timer.inicio);
    if (ini && now - ini > 3 * 3600000) {
      al.push({ nivel: 'atencao', materia: timer.materia, texto: `Timer de ${timer.materia} aberto há ${fmtMin((now - ini) / 60000)}. Esqueceu de parar?` });
    }
  }
  const ordem = { critico: 0, atencao: 1, info: 2 };
  return al.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}

// ---------------------------------------------------------------- acoes

function novoId() { return crypto.randomBytes(6).toString('hex'); }
function normFoco(v) { const f = num(v); return f != null && f >= 1 && f <= 5 ? Math.round(f) : null; }
function normTopicoRef(v) { if (obj(v)) return str(v.id); return str(v); }

function encerrarTimer({ foco, nota } = {}, now = new Date()) {
  if (!timer) return null;
  const ini = parseISO(timer.inicio);
  const t = timer;
  timer = null;
  salvarTimer();
  if (!ini) return null;
  const ms = now - ini;
  if (ms < 60000) { log('timer descartado, menos de 60 s:', t.materia); return null; }
  const s = {
    id: novoId(), materia: t.materia, topico: t.topico ?? null, topico_id: t.topico_id ?? null,
    inicio: isoSP(ini), fim: isoSP(now), minutos: rnd(ms / 60000),
    foco: normFoco(foco), nota: str(nota) ? str(nota).slice(0, 1000) : null, origem: 'timer', fonte: t.origem || 'painel',
  };
  sessoes.push(s);
  salvarSessoes();
  return s;
}

function timerOut() {
  if (!timer) return null;
  return {
    materia: timer.materia, topico: timer.topico ?? null, topico_id: timer.topico_id ?? null,
    inicio: timer.inicio, origem: timer.origem || 'painel', ultimo_ping: timer.ultimo_ping ?? null,
  };
}
function novoTimer(materia, tp, origem, now, comPing) {
  timer = {
    materia, topico: tp.id || tp.nome || null, topico_id: tp.id || null, inicio: isoSP(now),
    origem, ultimo_ping: comPing ? isoSP(now) : null,
  };
  salvarTimer();
}
function mesmoTopico(t, tp) {
  if (t.topico_id && tp.id) return t.topico_id === tp.id;
  return semAcento(t.topico || '') === semAcento(tp.id || tp.nome || '');
}
// Minutos acumulados num topico: sessoes fechadas mais o trecho aberto.
function minutosTopico(materia, tp, now) {
  const topicos = topicosDaMateria(materia);
  let tot = 0;
  for (const x of sessoes) {
    if (x.materia !== materia) continue;
    const t = casarTopico(topicos, x.topico_id, x.topico);
    if ((tp.id && t.id === tp.id) || (!tp.id && tp.nome && semAcento(t.nome || '') === semAcento(tp.nome))) tot += minSessao(x);
  }
  if (timer && timer.materia === materia && mesmoTopico(timer, tp)) tot += Math.max(0, (now - parseISO(timer.inicio)) / 60000);
  return rnd(tot);
}
const PING_LIMITE_MS = 12 * 60000, PING_FOLGA_MS = 2 * 60000;
// Fecha sozinho o timer que recebe ping e ficou sem ping por mais de 12 min.
function autoFecharTimer(now = new Date()) {
  if (!timer || !timer.ultimo_ping) return false;
  const up = parseISO(timer.ultimo_ping);
  if (!up || now - up <= PING_LIMITE_MS) return false;
  log('timer fechado por falta de ping:', timer.materia);
  encerrarTimer({}, new Date(up.getTime() + PING_FOLGA_MS));
  return true;
}
function pingTimer(corpo, now = new Date()) {
  const materia = (str(corpo.materia) || '').toUpperCase();
  autoFecharTimer(now);
  const tp = casarTopico(topicosDaMateria(materia), corpo.topico_id, corpo.topico);
  let ignorado = false;
  if (!timer) {
    novoTimer(materia, tp, 'sessao', now, true);
  } else if (timer.materia === materia) {
    const semTopicoAntes = !timer.topico && !timer.topico_id;
    const temTopico = !!(tp.id || tp.nome);
    if (!temTopico || mesmoTopico(timer, tp)) {
      timer.ultimo_ping = isoSP(now);
      salvarTimer();
    } else if (semTopicoAntes) {
      timer.topico = tp.id || tp.nome; timer.topico_id = tp.id || null; timer.ultimo_ping = isoSP(now);
      salvarTimer();
    } else {
      const origem = timer.origem || 'painel';
      encerrarTimer({}, now);
      novoTimer(materia, tp, origem, now, true);
    }
  } else if ((timer.origem || 'painel') === 'painel' && now - parseISO(timer.inicio) < 5 * 60000) {
    ignorado = true;
  } else {
    encerrarTimer({}, now);
    novoTimer(materia, tp, 'sessao', now, true);
  }
  return { ok: true, ...(ignorado ? { ignorado: true } : {}), timer: timerOut(), topico_min_total: minutosTopico(materia, tp, now) };
}

// ---------------------------------------------------------------- SSE

const clientes = new Set();
function payloadState() { return `event: state\ndata: ${JSON.stringify(computeState())}\n\n`; }
function broadcast() {
  if (!clientes.size) return;
  let p;
  try { p = payloadState(); } catch (e) { log('erro calculando State:', (e && e.stack) || e); return; }
  for (const c of clientes) { try { c.write(p); } catch (_) { clientes.delete(c); } }
}
let tBroadcast = null;
function mudou() { clearTimeout(tBroadcast); tBroadcast = setTimeout(broadcast, 150); }
setInterval(() => { try { if (autoFecharTimer()) mudou(); } catch (e) { log('erro no autoFechar:', e.message); } }, 30000);
try { autoFecharTimer(); } catch (e) { log('erro no autoFechar:', e.message); }
setInterval(broadcast, 30000);
setInterval(() => { for (const c of clientes) { try { c.write(': ping\n\n'); } catch (_) { clientes.delete(c); } } }, 15000);
try {
  fs.watch(MAT_DIR, (ev, nome) => { if (nome && /\.json$/.test(nome)) mudou(); });
  fs.watch(DATA_DIR, (ev, nome) => { if (nome === 'rotina.json' || nome === 'por_ultimo.json') mudou(); });
} catch (e) { log('fs.watch indisponível:', e.message); }

// ---------------------------------------------------------------- HTTP

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function enviar(res, code, corpo, tipo = 'application/json; charset=utf-8') {
  const txt = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(code, { ...CORS, 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(txt);
}
const erro = (res, code, msg) => enviar(res, code, { ok: false, erro: msg });
const enviarState = (res) => { enviar(res, 200, computeState()); mudou(); };

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > MAX_BODY) { reject(Object.assign(new Error('Corpo grande demais.'), { code: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}
async function lerJSON(req, { opcional = true } = {}) {
  const txt = await lerCorpo(req);
  if (!txt.trim()) {
    if (opcional) return {};
    throw Object.assign(new Error('Corpo vazio.'), { code: 400 });
  }
  try { return JSON.parse(txt); } catch (_) { throw Object.assign(new Error('JSON inválido.'), { code: 400 }); }
}

const PAGINA_PROVISORIA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel de Estudos</title>
<style>body{margin:0;background:#0A0A0C;color:#F1EDE6;font:16px/1.5 ui-monospace,Menlo,monospace;display:grid;place-items:center;min-height:100vh}
p{color:#B4AEA2}b{color:#F0913E}</style></head><body><div><b>PAINEL_ESTUDOS</b><p>A tela ainda está sendo construída. A API já responde em /api/state.</p></div></body></html>`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function servirEstatico(res, rel) {
  const alvo = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!alvo.startsWith(PUBLIC_DIR + path.sep)) return erro(res, 404, 'Não encontrado.');
  fs.readFile(alvo, (e, buf) => {
    if (e) {
      if (rel === '/index.html') return enviar(res, 200, PAGINA_PROVISORIA, MIME['.html']);
      return erro(res, 404, 'Não encontrado.');
    }
    enviar(res, 200, buf, MIME[path.extname(alvo)] || 'application/octet-stream');
  });
}

async function rotear(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const M = req.method;

  if (M === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (M === 'GET' && (p === '/' || p === '/index.html')) return servirEstatico(res, '/index.html');

  if (M === 'GET' && p === '/api/state') return enviar(res, 200, computeState());

  if (M === 'GET' && p === '/api/events') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    try { res.write(payloadState()); } catch (e) { log('erro no State inicial do SSE:', e.message); }
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
    return;
  }

  let m = /^\/api\/materia\/([^/]+)$/.exec(p);
  if (m) {
    const sigla = decodeURIComponent(m[1]).toUpperCase();
    if (!SIGLAS.includes(sigla)) return erro(res, 400, `Sigla desconhecida. Use uma destas: ${SIGLAS.join(', ')}.`);
    if (M === 'POST') {
      const corpo = await lerJSON(req, { opcional: false });
      if (!obj(corpo)) return erro(res, 400, 'O corpo precisa ser um objeto JSON.');
      const dados = { ...corpo, sigla, recebido_em: isoSP(new Date()) };
      writeAtomic(arquivoMateria(sigla), dados);
      cacheMat.delete(sigla);
      log('matéria recebida:', sigla);
      gravarSnapshot();
      mudou();
      return enviar(res, 200, { ok: true });
    }
    if (M === 'GET') {
      const st = computeState();
      const mt = st.materias[sigla];
      return enviar(res, 200, { ...(mt.dados || { sigla }), sigla, tem_dados: mt.tem_dados, calc: mt.calc, estudo: mt.estudo, tempo_por_topico: mt.calc.tempo_por_topico });
    }
    return erro(res, 405, 'Método não permitido.');
  }

  if (M === 'POST' && p === '/api/timer/start') {
    const corpo = obj(await lerJSON(req)) || {};
    const materia = (str(corpo.materia) || '').toUpperCase();
    if (!SIGLAS.includes(materia)) return erro(res, 400, `Matéria inválida. Use uma destas: ${SIGLAS.join(', ')}.`);
    const now = new Date();
    if (timer) encerrarTimer({}, now);
    const tp = casarTopico(topicosDaMateria(materia), corpo.topico_id, normTopicoRef(corpo.topico));
    novoTimer(materia, tp, 'painel', now, false);
    log('timer iniciado:', materia);
    return enviarState(res);
  }
  if (M === 'POST' && p === '/api/timer/ping') {
    const corpo = obj(await lerJSON(req)) || {};
    const materia = (str(corpo.materia) || '').toUpperCase();
    if (!SIGLAS.includes(materia)) return erro(res, 400, `Matéria inválida. Use uma destas: ${SIGLAS.join(', ')}.`);
    const r = pingTimer(corpo);
    mudou();
    return enviar(res, 200, r);
  }
  if (M === 'POST' && p === '/api/timer/stop') {
    const corpo = obj(await lerJSON(req)) || {};
    encerrarTimer({ foco: corpo.foco, nota: corpo.nota });
    return enviarState(res);
  }
  if (M === 'POST' && p === '/api/timer/cancel') {
    await lerCorpo(req);
    if (timer) { timer = null; salvarTimer(); }
    return enviarState(res);
  }

  if (M === 'POST' && p === '/api/sessao') {
    const corpo = obj(await lerJSON(req)) || {};
    const materia = (str(corpo.materia) || '').toUpperCase();
    if (!SIGLAS.includes(materia)) return erro(res, 400, `Matéria inválida. Use uma destas: ${SIGLAS.join(', ')}.`);
    const minutos = num(corpo.minutos);
    if (minutos == null || minutos <= 0 || minutos > 24 * 60) return erro(res, 400, 'Minutos precisa ser um número entre 1 e 1440.');
    let ini = corpo.inicio != null ? parseISO(corpo.inicio) : null;
    if (corpo.inicio != null && !ini) return erro(res, 400, 'Início precisa ser uma data ISO.');
    if (!ini) ini = new Date(Date.now() - minutos * 60000);
    const tpm = casarTopico(topicosDaMateria(materia), corpo.topico_id, normTopicoRef(corpo.topico));
    const s = {
      id: novoId(), materia, topico: tpm.id || tpm.nome || null, topico_id: tpm.id || null,
      inicio: isoSP(ini), fim: isoSP(new Date(ini.getTime() + minutos * 60000)), minutos: rnd(minutos),
      foco: normFoco(corpo.foco), nota: str(corpo.nota) ? str(corpo.nota).slice(0, 1000) : null, origem: 'manual',
    };
    sessoes.push(s);
    salvarSessoes();
    return enviarState(res);
  }

  m = /^\/api\/sessao\/([^/]+)$/.exec(p);
  if (m && M === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const antes = sessoes.length;
    sessoes = sessoes.filter((s) => s.id !== id);
    if (sessoes.length === antes) return erro(res, 404, 'Sessão não encontrada.');
    salvarSessoes();
    return enviarState(res);
  }

  if (M === 'POST' && p === '/api/config') {
    const corpo = obj(await lerJSON(req)) || {};
    const novo = { ...config };
    for (const k of ['horas_dia_semana', 'horas_dia_fds']) {
      if (corpo[k] === undefined) continue;
      const v = num(corpo[k]);
      if (v == null || v < 0 || v > 24) return erro(res, 400, `${k} precisa ser um número entre 0 e 24.`);
      novo[k] = v;
    }
    if (corpo.dorme_hoje !== undefined || corpo.acorda_amanha !== undefined) {
      const now = agoraServidor();
      const aj = ajusteValido(now) || {};
      let dorme = aj.dorme ?? null, acorda = aj.acorda ?? null;
      if (corpo.dorme_hoje !== undefined) {
        if (corpo.dorme_hoje !== null && !parseHora(corpo.dorme_hoje)) return erro(res, 400, 'dorme_hoje precisa ser HH:MM.');
        dorme = corpo.dorme_hoje ? parseHora(corpo.dorme_hoje).txt : null;
      }
      if (corpo.acorda_amanha !== undefined) {
        if (corpo.acorda_amanha !== null && !parseHora(corpo.acorda_amanha)) return erro(res, 400, 'acorda_amanha precisa ser HH:MM.');
        acorda = corpo.acorda_amanha ? parseHora(corpo.acorda_amanha).txt : null;
      }
      const hoje = ymdSP(now);
      const rot = lerRotina().rotina;
      const ac = acorda ? minHM(acorda) : rot.acorda;
      novo.dorme_hoje = dorme; novo.acorda_amanha = acorda; novo.ajuste_data = hoje;
      novo.ajuste_valido_ate = (dorme || acorda) ? isoSP(minParaDate(addDays(hoje, 1), ac)) : null;
    }
    if (corpo.rotina !== undefined) {
      const rp = obj(corpo.rotina);
      if (!rp) return erro(res, 400, 'rotina precisa ser um objeto.');
      let atual = obj(readJSON(F_ROTINA, null)) || JSON.parse(JSON.stringify(ROTINA_PADRAO));
      for (const k of ['acorda', 'dorme']) {
        if (rp[k] === undefined) continue;
        if (!parseHora(rp[k])) return erro(res, 400, `rotina.${k} precisa ser HH:MM.`);
        atual[k] = parseHora(rp[k]).txt;
      }
      if (!normRotina(atual)) return erro(res, 400, 'Rotina inválida: dorme precisa ser depois de acorda.');
      writeAtomic(F_ROTINA, atual);
    }
    config = novo;
    salvarConfig();
    return enviarState(res);
  }

  if (M === 'POST' && p === '/api/marca') {
    const corpo = obj(await lerJSON(req)) || {};
    const materia = (str(corpo.materia) || '').toUpperCase(), id = str(corpo.id), estado = corpo.estado == null ? null : str(corpo.estado);
    if (!SIGLAS.includes(materia) || !id) return erro(res, 400, 'Informe materia e id da avaliação.');
    if (estado !== null && estado !== 'pronto' && estado !== 'entregue') return erro(res, 400, 'estado precisa ser pronto, entregue ou null.');
    const mk = lerMarcas();
    if (estado) mk[`${materia}:${id}`] = { estado, em: isoSP(new Date()) }; else delete mk[`${materia}:${id}`];
    writeAtomic(F_MARCAS, mk);
    mudou();
    return enviarState(res);
  }

  m = /^\/api\/tarefa(?:\/([^/]+))?$/.exec(p);
  if (m) {
    const lista = lerTarefas();
    const campos = (t, corpo) => {
      if (corpo.titulo !== undefined) { const v = str(corpo.titulo); if (!v) return 'titulo não pode ser vazio.'; t.titulo = v.slice(0, 200); }
      if (corpo.materia !== undefined) { const v = (str(corpo.materia) || '').toUpperCase(); if (v && !SIGLAS.includes(v)) return 'Matéria inválida.'; t.materia = v || null; }
      if (corpo.data !== undefined) { if (corpo.data && !parseYmd(corpo.data)) return 'data precisa ser AAAA-MM-DD ou null.'; t.data = corpo.data ? parseYmd(corpo.data) : null; }
      if (corpo.feito !== undefined) { t.feito = corpo.feito === true; t.feito_em = t.feito ? isoSP(new Date()) : null; }
      return null;
    };
    if (!m[1] && M === 'POST') {
      const corpo = obj(await lerJSON(req)) || {};
      const t = { id: novoId(), titulo: null, materia: null, data: null, feito: false, feito_em: null, criado_em: isoSP(new Date()) };
      const e = campos(t, corpo) || (!t.titulo ? 'Informe o titulo.' : null);
      if (e) return erro(res, 400, e);
      lista.push(t);
    } else if (m[1]) {
      const id = decodeURIComponent(m[1]), i = lista.findIndex((t) => t.id === id);
      if (i < 0) return erro(res, 404, 'Tarefa não encontrada.');
      if (M === 'DELETE') lista.splice(i, 1);
      else if (M === 'POST') { const e = campos(lista[i], obj(await lerJSON(req)) || {}); if (e) return erro(res, 400, e); }
      else return erro(res, 405, 'Método não permitido.');
    } else return erro(res, 405, 'Método não permitido.');
    writeAtomic(F_TAREFAS, lista);
    mudou();
    return enviarState(res);
  }

  if (M === 'GET' && !p.startsWith('/api/')) return servirEstatico(res, p);
  return erro(res, 404, 'Rota não encontrada.');
}

const server = http.createServer((req, res) => {
  rotear(req, res).catch((e) => {
    const code = e && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) log('erro na rota', req.method, req.url, (e && e.stack) || e);
    if (!res.headersSent) erro(res, code, code === 500 ? 'Erro interno.' : e.message);
    else try { res.end(); } catch (_) { /* segue */ }
  });
});
server.on('error', (e) => {
  log('erro do servidor:', e.message);
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') process.exit(1);
});
server.listen(PORT, HOST, () => {
  log(`painel-estudos ouvindo em http://${HOST}:${PORT} (dados em ${DATA_DIR})`);
  sincronizarCalendario();
  setInterval(sincronizarCalendario, CAL_INTERVALO_MS);
  gravarSnapshot();
  setInterval(gravarSnapshot, CAL_INTERVALO_MS);
});

function sair(sig) {
  log('encerrando por', sig);
  for (const c of clientes) { try { c.end(); } catch (_) { /* segue */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => sair('SIGTERM'));
process.on('SIGINT', () => sair('SIGINT'));
