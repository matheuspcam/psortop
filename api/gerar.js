export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { pin, tipoAtendimento, dadosCaso, atendimentoInicial, template, extra } = req.body;

  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }

  if (!dadosCaso || !template) {
    return res.status(400).json({ erro: 'Faltam dados do caso ou template selecionado' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: 'Chave da API não configurada no servidor' });
  }

  const promptSistema = montarPromptSistema();
  const promptUsuario = montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra });

  try {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ parts: [{ text: promptUsuario }] }],
          generationConfig: { temperature: 0.3 }
        })
      }
    );

    const data = await resposta.json();

    if (!resposta.ok) {
      console.error('Erro da API Gemini:', data);
      return res.status(502).json({ erro: 'Erro ao gerar o texto. Tente novamente.' });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) {
      return res.status(502).json({ erro: 'Resposta vazia do modelo. Tente novamente.' });
    }

    return res.status(200).json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha de conexão com a API' });
  }
}

function montarPromptSistema() {
  return `Você é um assistente médico especializado em ortopedia em pronto-socorro, com foco em documentação clínica de alto nível técnico, clareza, objetividade e segurança médico-legal.
Sua função é estruturar prontuários médicos completos, com linguagem técnica, concisa, direta e adequada para registro hospitalar.

REGRAS GERAIS:
- Linguagem médica formal
- Evitar redundâncias
- Frases curtas e objetivas
- Não usar termos vagos
- Sempre incluir elementos de segurança médico-legal quando aplicável
- Não inventar dados — trabalhar apenas com o que for fornecido
- Caso faltem informações relevantes, sinalize isso claramente no início da resposta, antes do texto do prontuário
- Os dados que o médico envia podem estar corridos, diretos, picotados ou informais — sua função é organizar, corrigir e adequar ao padrão do template, nunca replicar o estilo de escrita recebido

REGRAS DE USO DOS TEMPLATES:
- Os modelos fornecidos são padrões de redação, não textos para copiar cegamente
- O exame físico dos modelos está escrito no padrão "tudo normal". Sempre que for informado um achado alterado (dor, edema, deformidade, déficit, limitação etc.), substitua a linha correspondente pelo achado real. Nunca mantenha uma negativa que contradiga o que foi informado
- As linhas de CONDUTA funcionam como um menu: inclua apenas as que se aplicam ao caso informado. Não inclua imobilização, atestado, internação ou orientação de não apoio se isso não foi mencionado
- Nunca combine no mesmo texto condutas mutuamente excludentes (ex: alta ambulatorial e indicação de internação)
- Campos entre colchetes ([SEGMENTO], [TEMPO], [HOSPITAL], [MÉDICO DA RETAGUARDA] etc.) devem ser preenchidos com o que for informado. Se não houver informação suficiente, sinalize isso no início da resposta

ESTRUTURA:
Siga EXATAMENTE o modelo de referência fornecido (inclusive estilo, maiúsculas, divisões e organização).

ESTILO DE SAÍDA:
- Texto contínuo (sem tópicos, salvo se o modelo tiver)
- Alta densidade informativa
- Padrão de prontuário hospitalar
- Direto ao ponto

Se for reavaliação, mantenha coerência com o atendimento inicial informado e destaque a evolução em relação ao quadro inicial.

Responda SOMENTE com o texto final do prontuário, pronto para copiar. Se precisar sinalizar algo faltante, coloque isso em uma linha separada antes do texto, começando com "⚠️ ATENÇÃO:".`;
}

const TEMPLATES = {
  a: {
    nome: '1º Atendimento',
    texto: `AP: nega alergias, comorbidades ou medicações de uso contínuo

QD:

EXAME FÍSICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Indolor à palpação.
Sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Solicito radiografias
Reavaliação após [TEMPO]`
  },
  b: {
    nome: 'Anamnese Completa em 1 Etapa',
    texto: `QD:

EXAME FÍSICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Indolor à palpação.
Sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.

[LINHAS OPCIONAIS — incluir apenas se aplicável ao caso:]
Forneço atestado médico
Realizada imobilização do segmento acometido com tala gessada suropodálica, em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  },
  c: {
    nome: 'Liberação — RX Limpo',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia.
Orientado repouso relativo, evitando esforços e impacto sobre o segmento acometido até reavaliação.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica em cerca de 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento, com eventual complementação propedêutica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, edema progressivo, limitação funcional importante, alteração de sensibilidade ou força, alteração de coloração do membro, febre ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  d: {
    nome: 'Liberação — Fratura',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura em região de [SEGMENTO], sem sinais de desvio significativo ou instabilidade evidente ao método, passível de tratamento incruento conforme padrão atual.

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Forneço atestado médico
Realizada imobilização do segmento acometido com [TIPO DE IMOBILIZAÇÃO], em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.`
  },
  e: {
    nome: 'Lombago — Miguê',
    texto: `AP: Nega alergias, comorbidades ou uso de medicações contínuas.

HPMA: Paciente refere lombalgia crônica, com agudização do quadro há [TEMPO].
Nega história de trauma. Nega febre ou outros sinais flogísticos. Nega perda ponderal. Nega alterações esfincterianas. Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Dor à palpação da musculatura paravertebral lombar, sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores e inferiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar.
Esclarecido que o quadro deve ser acompanhado, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, alterações de sensibilidade ou força, alterações esfincterianas ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM ambulatorialmente
Alta da ortopedia.`
  },
  f: {
    nome: 'Canetada Internar',
    texto: `CONDUTA:
Caso encaminhado à equipe de retaguarda cirúrgica do [HOSPITAL].
Representada na presente data pela equipe do [MÉDICO DA RETAGUARDA].
Formalmente discutido com a equipe de retaguarda, que, após análise clínica e dos exames disponíveis, indica internação hospitalar para tratamento cirúrgico como conduta definitiva.
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  }
};

const NOMES_TIPO = {
  inicial: 'Atendimento inicial (paciente será reavaliado depois, ainda sem desfecho)',
  reavaliacao: 'Reavaliação (de atendimento anterior, já com desfecho a definir)',
  completo: 'Atendimento completo (avaliado e resolvido nesta mesma consulta)'
};

function montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra }) {
  const templatesEscolhidos = String(template)
    .split('+')
    .map(t => t.trim())
    .filter(Boolean);

  const blocosTemplate = templatesEscolhidos
    .map(t => TEMPLATES[t])
    .filter(Boolean)
    .map(t => `--- MODELO: ${t.nome} ---\n${t.texto}`)
    .join('\n\n');

  let partes = [];
  partes.push(`TIPO DE ATENDIMENTO: ${NOMES_TIPO[tipoAtendimento] || tipoAtendimento}`);

  if (tipoAtendimento === 'reavaliacao' && atendimentoInicial) {
    partes.push(`\nATENDIMENTO INICIAL (para contexto e coerência — destaque a evolução em relação a isto):\n${atendimentoInicial}`);
  }

  partes.push(`\nDADOS DO CASO ATUAL:\n${dadosCaso}`);

  if (extra && extra.trim()) {
    partes.push(`\nINFORMAÇÕES ADICIONAIS (ex: resultado de exame, achados específicos):\n${extra}`);
  }

  partes.push(`\nMODELO(S) DE REFERÊNCIA A SEGUIR:\n${blocosTemplate}`);

  partes.push(`\nGere o prontuário completo agora, seguindo exatamente a estrutura do(s) modelo(s) acima, adaptado aos dados fornecidos.`);

  return partes.join('\n');
}
