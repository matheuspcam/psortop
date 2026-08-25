// Guarda sugestões de mudança pendentes, feitas durante o plantão, para revisão em lote depois.
// Usa o Upstash Redis REST API (mesmo serviço por trás do "Vercel KV" atual).
// Variáveis de ambiente necessárias: KV_REST_API_URL e KV_REST_API_TOKEN
// (criadas automaticamente ao conectar um banco Upstash/KV ao projeto na Vercel).

const CHAVE_LISTA = 'ortopia:sugestoes';

async function upstash(comando) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Banco de dados não configurado no servidor (KV_REST_API_URL / KV_REST_API_TOKEN ausentes).');
  }

  const resposta = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(comando)
  });

  const data = await resposta.json();
  if (!resposta.ok || data.error) {
    throw new Error(data.error || 'Erro ao acessar o banco de dados.');
  }
  return data.result;
}

export default async function handler(req, res) {
  const { pin } = req.method === 'GET' ? req.query : (req.body || {});

  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }

  try {
    if (req.method === 'POST') {
      const { aba, template, resultadoGerado, observacao } = req.body;

      if (!observacao || !observacao.trim()) {
        return res.status(400).json({ erro: 'Escreva a observação antes de salvar.' });
      }

      const item = {
        data: new Date().toISOString(),
        aba: aba || '',
        template: template || '',
        resultadoGerado: resultadoGerado || '',
        observacao: observacao.trim()
      };

      await upstash(['RPUSH', CHAVE_LISTA, JSON.stringify(item)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const itensRaw = await upstash(['LRANGE', CHAVE_LISTA, '0', '-1']);
      const itens = (itensRaw || []).map(function(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
      }).filter(Boolean);
      return res.status(200).json({ itens: itens });
    }

    if (req.method === 'DELETE') {
      await upstash(['DEL', CHAVE_LISTA]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: e.message || 'Falha ao acessar o banco de dados.' });
  }
}
