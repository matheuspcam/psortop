// "Torre de controle" (pedido do médico, 14/10/2026): lista de pacientes do plantão, por turno e local.
// Guarda cada paciente como um campo de um hash no Upstash Redis (mesmas variáveis das sugestões:
// KV_REST_API_URL e KV_REST_API_TOKEN). Protegida pelo PIN do site.
// Nada some sozinho, exceto a Lixeira: item apagado fica 7 dias e depois é removido de vez do servidor.
// A limpeza roda a cada chamada à Torre (listar ou salvar).

const CHAVE = 'ortopia:torre';
const DIAS_LIXEIRA = 7;
const MAX_ITENS = 600;
const STATUS_VALIDOS = ['ativo', 'arquivar', 'lixeira'];
const TURNOS_VALIDOS = ['07-19', '10-22', '19-07'];
const CORES_VALIDAS = ['', 'amarelo', 'vermelho', 'verde'];

async function upstash(comando) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Banco de dados não configurado no servidor.');
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const data = await resposta.json();
  if (!resposta.ok || data.error) throw new Error(data.error || 'Erro ao acessar o banco de dados.');
  return data.result;
}

function texto(v, max) {
  const t = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return t.slice(0, max);
}

function limparItem(bruto) {
  const i = bruto && typeof bruto === 'object' ? bruto : {};
  const id = texto(i.id, 60).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  const aguarda = Array.isArray(i.aguarda) ? i.aguarda.slice(0, 30).map(function (a) {
    const x = a || {};
    return { k: texto(x.k, 60), ok: !!x.ok, txt: texto(x.txt, 200) };
  }).filter(function (a) { return a.k; }) : [];
  return {
    id: id,
    nome: texto(i.nome, 160),
    numero: texto(i.numero, 40),
    hipotese: texto(i.hipotese, 400),
    turno: TURNOS_VALIDOS.indexOf(i.turno) !== -1 ? i.turno : '07-19',
    dataTurno: /^\d{4}-\d{2}-\d{2}$/.test(i.dataTurno || '') ? i.dataTurno : '',
    local: texto(i.local, 80),
    aguarda: aguarda,
    obs: texto(i.obs, 3000),
    checar: texto(i.checar, 1500),
    cor: CORES_VALIDAS.indexOf(i.cor) !== -1 ? i.cor : '',
    status: STATUS_VALIDOS.indexOf(i.status) !== -1 ? i.status : 'ativo',
    statusAntes: STATUS_VALIDOS.indexOf(i.statusAntes) !== -1 ? i.statusAntes : '',
    ordem: Number.isFinite(Number(i.ordem)) ? Number(i.ordem) : 0,
    criadoEm: texto(i.criadoEm, 40),
    atualizadoEm: new Date().toISOString(),
    lixeiraEm: i.status === 'lixeira' ? (texto(i.lixeiraEm, 40) || new Date().toISOString()) : ''
  };
}

async function listarELimpar() {
  const plano = (await upstash(['HGETALL', CHAVE])) || [];
  const itens = [];
  const vencidos = [];
  const limite = Date.now() - DIAS_LIXEIRA * 24 * 3600 * 1000;
  for (let n = 0; n + 1 < plano.length; n += 2) {
    let item;
    try { item = JSON.parse(plano[n + 1]); } catch (e) { continue; }
    if (!item || !item.id) continue;
    if (item.status === 'lixeira' && item.lixeiraEm && new Date(item.lixeiraEm).getTime() < limite) {
      vencidos.push(plano[n]);
      continue;
    }
    itens.push(item);
  }
  if (vencidos.length) await upstash(['HDEL', CHAVE].concat(vencidos));
  return itens;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  const { pin, acao } = req.body || {};
  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) return res.status(401).json({ erro: 'PIN incorreto' });

  try {
    if (acao === 'salvar') {
      // Aceita um item ou vários (usado para reordenar).
      const corpo = req.body || {};
      const lista = Array.isArray(corpo.itens) ? corpo.itens : (corpo.item ? [corpo.item] : []);
      const limpos = lista.slice(0, 50).map(limparItem).filter(Boolean);
      if (!limpos.length) return res.status(400).json({ erro: 'Nada para salvar.' });
      const existentes = await upstash(['HLEN', CHAVE]);
      const comandos = [];
      limpos.forEach(function (i) { comandos.push(i.id, JSON.stringify(i)); });
      if (Number(existentes) >= MAX_ITENS) {
        const atuais = await listarELimpar();
        if (atuais.length >= MAX_ITENS) return res.status(400).json({ erro: 'Torre cheia. Apague pacientes antigos.' });
      }
      await upstash(['HSET', CHAVE].concat(comandos));
      // Aproveita a chamada para varrer a lixeira vencida.
      await listarELimpar();
      return res.status(200).json({ ok: true, itens: limpos });
    }

    if (acao === 'excluir') {
      const id = texto((req.body || {}).id, 60).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return res.status(400).json({ erro: 'Paciente não informado.' });
      await upstash(['HDEL', CHAVE, id]);
      return res.status(200).json({ ok: true });
    }

    // listar
    const itens = await listarELimpar();
    return res.status(200).json({ itens: itens });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: e.message || 'Falha na Torre de controle.' });
  }
}
