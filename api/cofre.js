// "Senhas e links": cofre de links e credenciais do dia a dia.
// Fica guardado no mesmo Upstash das sugestões (nunca no código do GitHub).
// Exige o PIN do site E uma senha própria do cofre (variável COFRE_SENHA na Vercel),
// pedida toda vez que a seção é aberta. Cada abertura fica registrada (data, IP, aparelho).
// Após 5 senhas erradas, o cofre fica bloqueado por 15 minutos.

const CHAVE_ITENS = 'ortopia:cofre:itens';
const CHAVE_ACESSOS = 'ortopia:cofre:acessos';
const CHAVE_FALHAS = 'ortopia:cofre:falhas';
const MAX_FALHAS = 5;
const BLOQUEIO_SEG = 15 * 60;
const MAX_ITENS = 200;
const MAX_CAMPO = 2000;

async function upstash(comando) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Banco de dados não configurado no servidor (KV_REST_API_URL / KV_REST_API_TOKEN ausentes).');
  }
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const data = await resposta.json();
  if (!resposta.ok || data.error) throw new Error(data.error || 'Erro ao acessar o banco de dados.');
  return data.result;
}

function cortar(v) {
  const t = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return t.trim().slice(0, MAX_CAMPO);
}

async function lerItens() {
  const raw = await upstash(['GET', CHAVE_ITENS]);
  if (!raw) return [];
  try { const lista = JSON.parse(raw); return Array.isArray(lista) ? lista : []; } catch (e) { return []; }
}

async function gravarItens(lista) {
  await upstash(['SET', CHAVE_ITENS, JSON.stringify(lista.slice(0, MAX_ITENS))]);
}

function comparacaoSegura(a, b) {
  const x = String(a || ''), y = String(b || '');
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    dif |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return dif === 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { pin, senha, acao, item, id } = req.body || {};

  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }
  if (!process.env.COFRE_SENHA) {
    return res.status(500).json({ erro: 'Senha do cofre não configurada na Vercel (variável COFRE_SENHA).' });
  }

  try {
    const falhas = parseInt(await upstash(['GET', CHAVE_FALHAS]) || '0', 10);
    if (falhas >= MAX_FALHAS) {
      return res.status(429).json({ erro: 'Muitas tentativas erradas. Cofre bloqueado por 15 minutos.' });
    }

    await new Promise(r => setTimeout(r, 400));

    if (!comparacaoSegura(senha, process.env.COFRE_SENHA)) {
      await upstash(['INCR', CHAVE_FALHAS]);
      await upstash(['EXPIRE', CHAVE_FALHAS, String(BLOQUEIO_SEG)]);
      return res.status(401).json({ erro: 'Senha do cofre incorreta.' });
    }
    await upstash(['DEL', CHAVE_FALHAS]);

    if (acao === 'listar') {
      const registro = {
        data: new Date().toISOString(),
        ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
        aparelho: String(req.headers['user-agent'] || '').slice(0, 200)
      };
      await upstash(['LPUSH', CHAVE_ACESSOS, JSON.stringify(registro)]);
      await upstash(['LTRIM', CHAVE_ACESSOS, '0', '99']);

      const itens = await lerItens();
      const acessosRaw = await upstash(['LRANGE', CHAVE_ACESSOS, '0', '19']);
      const acessos = (acessosRaw || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      return res.status(200).json({ itens, acessos });
    }

    if (acao === 'salvar') {
      const novo = item || {};
      const titulo = cortar(novo.titulo);
      if (!titulo) return res.status(400).json({ erro: 'Dê um nome ao item.' });
      const tipo = ['link', 'senha', 'nota'].includes(novo.tipo) ? novo.tipo : 'nota';
      let url = cortar(novo.url);
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      const registro = {
        id: cortar(novo.id) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
        tipo,
        titulo,
        url,
        usuario: cortar(novo.usuario),
        senha: cortar(novo.senha),
        obs: cortar(novo.obs),
        atualizado: new Date().toISOString()
      };
      const lista = await lerItens();
      const pos = lista.findIndex(x => x.id === registro.id);
      if (pos >= 0) lista[pos] = registro; else lista.push(registro);
      await gravarItens(lista);
      return res.status(200).json({ ok: true, itens: lista });
    }

    if (acao === 'apagar') {
      const lista = (await lerItens()).filter(x => x.id !== id);
      await gravarItens(lista);
      return res.status(200).json({ ok: true, itens: lista });
    }

    return res.status(400).json({ erro: 'Ação inválida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: e.message || 'Falha ao acessar o cofre.' });
  }
}
