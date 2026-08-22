export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { pin, tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante } = req.body;

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
  const promptUsuario = montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante });

  try {
    const resposta = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ parts: [{ text: promptUsuario }] }],
          generationConfig: { temperature: 0.3 }
        })
      }
    );

    const data = await resposta.json();

    if (!resposta.ok) {
      console.error('Erro da API Gemini:', JSON.stringify(data));
      const detalhe = data?.error?.message ? ` (${data.error.message})` : '';
      return res.status(502).json({ erro: `Erro ao gerar o texto${detalhe}` });
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
- Não inventar dados clínicos — trabalhar apenas com o que for fornecido
- Os dados que o médico envia podem estar corridos, diretos, picotados ou informais — sua função é organizar, corrigir e adequar ao padrão do template, nunca replicar o estilo de escrita recebido

REGRA CRÍTICA — PROIBIDO DEIXAR LACUNAS NO TEXTO FINAL:
O texto do prontuário será copiado e colado DIRETO em um sistema hospitalar real, sem revisão linha a linha. Por isso:
- O texto final NUNCA pode conter colchetes, placeholders, reticências, "[a preencher]", "___", parênteses com a palavra "instrução", ou qualquer marcação indicando informação faltante
- Os modelos de referência abaixo contêm trechos entre parênteses começando com "(instrução: ...)" — esses trechos são orientações PARA VOCÊ seguir ao gerar o texto, e NUNCA devem aparecer, nem parafraseados, no resultado final. Siga a orientação (preencha com o dado informado ou aplique o fallback indicado) e apague o parêntese inteiro do texto de saída
- Se um dado do template não foi informado e não há fallback genérico indicado, omita a linha ou frase inteira, mantendo o restante do texto coerente
- Nunca deixe uma frase pela metade ou com um vazio visível
- Todo e qualquer aviso sobre informação faltante, ambígua, ou assumida vai SOMENTE na linha de aviso no topo (começando com "⚠️ "), nunca dentro do corpo do prontuário

REGRAS DE USO DOS TEMPLATES:
- Os modelos fornecidos são padrões de redação, não textos para copiar cegamente
- O exame físico dos modelos está escrito no padrão "tudo normal". Sempre que for informado um achado alterado (dor, edema, deformidade, déficit, limitação etc.), substitua a linha correspondente pelo achado real. Nunca mantenha uma negativa que contradiga o que foi informado
- As linhas de CONDUTA funcionam como um menu: inclua apenas as que se aplicam ao caso informado. Não inclua imobilização, atestado, internação ou orientação de não apoio se isso não foi mencionado
- Nunca combine no mesmo texto condutas mutuamente excludentes (ex: alta ambulatorial e indicação de internação)

ESTRUTURA:
Siga EXATAMENTE o modelo de referência fornecido (inclusive estilo, maiúsculas, divisões e organização).

ESTILO DE SAÍDA:
- Texto contínuo dentro de cada seção (sem tópicos, salvo se o modelo tiver)
- Alta densidade informativa
- Padrão de prontuário hospitalar
- Direto ao ponto
- OBRIGATÓRIO: deixe uma linha em branco entre cada seção do prontuário (ex: entre "QD:" e "EXAME FÍSICO:", entre "EXAME FÍSICO:" e "EM TEMPO:" ou "CONDUTA:", etc.). Dentro de uma mesma seção, as linhas ficam coladas sem espaço extra entre si — o espaço em branco é só entre uma seção e a próxima

Se for reavaliação, mantenha coerência com o atendimento inicial informado e destaque a evolução em relação ao quadro inicial.

FORMATO DA RESPOSTA:
Se precisar sinalizar algo faltante, ambíguo ou assumido, coloque isso em uma ou mais linhas no topo. CADA linha de aviso deve começar EXATAMENTE com "⚠️ " (esse emoji e um espaço, sem a palavra "ATENÇÃO" nem dois-pontos), seguida direto de um rótulo curtíssimo — 2 a 6 palavras, sem verbo, sem explicação (ex: "⚠️ Dados insuficientes", "⚠️ Nome da equipe não informado"). Se fizer sentido, inclua também uma linha curta de sugestão de melhoria no mesmo formato (ex: "⚠️ Sugestão: informar o segmento acometido"). Prefira várias linhas curtíssimas a uma linha longa. Depois de todos os avisos, deixe uma linha em branco, e então o texto do prontuário — já completo, corrido e pronto para copiar, sem nenhuma lacuna. Se não houver nada a sinalizar, não escreva nenhuma linha de aviso — vá direto para o texto do prontuário.`;
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
Reavaliação após (o médico informa o prazo/momento — ex: resultado de exame, algumas horas, retorno ainda neste plantão; nunca assuma um número de dias)`
  },
  b: {
    nome: 'Trauma (Anamnese 1 Etapa)',
    texto: `HDA: Paciente refere trauma em (instrução: cite o mecanismo e o segmento informados — ex: "trauma torcional em tornozelo", "trauma direto em joelho", "queda com apoio de mão") (instrução: lado D/E se informado) há (instrução: tempo informado), evoluindo com dor local (instrução: acrescente edema, dificuldade para deambular/mobilizar, ou outros sintomas associados se informados) desde então.
Nega outros traumas associados.
Nega outras queixas relevantes no momento.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado. (Instrução: se o toggle "relatado por acompanhante" estiver marcado, adicione aqui: "História relatada pelo acompanhante." Se o paciente for identificado como criança ou idoso e o toggle estiver marcado, mantenha a linguagem de exame física igual, apenas ajustando o sujeito da HDA para refletir que o relato veio do acompanhante, não do próprio paciente.)
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles. (Instrução: se houver edema informado, substitua esta linha citando a topografia — ex: "Edema em topografia de tornozelo lateral".)
Dor à palpação (instrução: cite a estrutura/região específica informada — ex: "ligamento talofibular anterior", "interlinha articular do joelho", "tabaqueira anatômica", "olécrano"; se não informado, use "no segmento acometido"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
(Instrução: se o caso envolver ombro com suspeita de lesão de manguito, adicione testes específicos apenas se mencionados pelo médico — ex: "Jobe negativo", "Neer negativo", "Patte negativo", "Gerber negativo". Se envolver luxação glenoumeral reduzida, ajuste a frase de perfusão para "Após redução, reavaliado mantendo perfusão distal preservada e sem déficits neurovasculares evidentes.")

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao (instrução: "paciente" normalmente; se o toggle de acompanhante estiver marcado, pode usar "paciente e ao acompanhante") o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada. (Instrução: se o toggle de acompanhante estiver marcado, ajuste para "Paciente e acompanhante referem compreensão das orientações, encontrando-se cientes da conduta adotada.")

(Instrução: as linhas abaixo são OPCIONAIS — inclua no texto final apenas as que se aplicam ao caso informado; nunca copie esta instrução nem os colchetes para o resultado)
Forneço atestado médico
Realizada imobilização do segmento acometido com (instrução: use o tipo de imobilização informado — ex: "tala gessada suropodálica", "órtese", "tornozeleira", "tipoia" — se não informado, use "dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.
Realizada redução incruenta com sucesso. (Instrução: use esta linha apenas em casos de luxação reduzida no PS.)
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
Avalio radiografias do segmento acometido, evidenciando fratura, sem sinais de desvio significativo ou instabilidade evidente ao método, passível de tratamento incruento conforme padrão atual. (Instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido")

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
Realizada imobilização do segmento acometido (instrução: use o tipo de imobilização informado pelo médico; se não informado, use "com dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.`
  },
  e1: {
    nome: 'Crônico — Lombalgia Mecânica',
    texto: `HDA: Paciente refere dor lombar há (instrução: tempo informado), com piora à mobilização, (instrução: "após esforço físico" ou "sem fator desencadeante definido", conforme informado).
Nega trauma.
Nega febre.
Nega perda ponderal inexplicada.
Nega alterações urinárias ou intestinais, retenção urinária, incontinência esfincteriana, anestesia em sela, déficit motor progressivo ou outros sinais de alarme no momento.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado, deambulando.
Sem lesões cutâneas, abaulamentos ou deformidades evidentes da coluna lombar.
Dor à palpação da musculatura paravertebral lombar.
Sem dor importante à palpação de proeminências ósseas.
Amplitude de movimento preservada ou discretamente limitada por dor.
Força muscular preservada globalmente em membros inferiores.
Sensibilidade preservada.
Sem déficits neurológicos focais detectáveis.
Lasègue negativo (instrução: incluir apenas se o médico mencionou ter testado).
Sem sinais clínicos de mielopatia ou síndrome da cauda equina.
Perfusão periférica preservada.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado repouso relativo e evitar esforços importantes.
Orientado retorno progressivo às atividades conforme tolerância.
Solicitado RM ambulatorial e encaminhado para seguimento ambulatorial. (Instrução: se o médico não mencionar solicitação de exame, omita esta linha.)
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial pode não demonstrar todas as causas em fase precoce, podendo haver necessidade de reavaliação conforme evolução clínica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de febre, déficit motor, alteração urinária ou intestinal, anestesia em sela, dor progressiva refratária ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e2: {
    nome: 'Crônico — Cervicalgia Mecânica',
    texto: `HDA: Paciente refere dor cervical há (instrução: tempo informado), com piora à mobilização, (instrução: "após esforço físico" ou "sem fator desencadeante definido", conforme informado).
Nega trauma.
Nega febre.
Nega parestesias, déficit motor, alteração esfincteriana ou outros sinais de alarme no momento.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado.
Sem lesões cutâneas, abaulamentos ou deformidades evidentes da coluna cervical.
Dor à palpação da musculatura paravertebral cervical / trapézio.
Sem dor importante à palpação de proeminências ósseas.
Amplitude de movimento preservada ou discretamente limitada por dor.
Força muscular preservada em membros superiores.
Sensibilidade preservada.
Sem déficits neurológicos focais detectáveis.
Spurling negativo (instrução: incluir apenas se testado).
Teste de distração negativo (instrução: incluir apenas se testado).
Sem sinais clínicos de mielopatia.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado repouso relativo e evitar esforços / movimentos bruscos.
(Instrução: se pertinente, incluir "Solicitado exame complementar ambulatorial" e/ou "encaminhado seguimento ambulatorial"; omitir se não mencionado.)
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial pode não demonstrar todas as causas em fase precoce, podendo haver necessidade de reavaliação conforme evolução clínica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de febre, déficit motor, alteração sensitiva progressiva, dor irradiada importante ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e3: {
    nome: 'Crônico — Torcicolo Agudo',
    texto: `HDA: Paciente refere dor cervical de início há (instrução: tempo informado), principalmente à rotação do pescoço.
Refere início (instrução: "ao acordar", "após movimento brusco" ou "sem trauma definido", conforme informado).
Nega trauma direto.
Nega febre.
Nega parestesias, déficit motor ou outras queixas associadas.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado.
Mantém atitude antálgica cervical.
Dor à palpação de musculatura esternocleidomastoidea, trapézio e/ou paracervical.
Amplitude de movimento cervical limitada por dor, principalmente à rotação.
Sem deformidade evidente.
Sem sinais flogísticos locais.
Força preservada em membros superiores.
Sensibilidade preservada.
Sem déficits neurológicos focais.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado repouso relativo e evitar movimentos bruscos.
Indicado colar cervical de espuma por curto período. (Instrução: incluir apenas se pertinente/mencionado.)
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial pode não demonstrar todas as causas em fase precoce, podendo haver necessidade de reavaliação conforme evolução clínica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de persistência importante, piora, febre, irradiação relevante, déficit neurológico ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e4: {
    nome: 'Crônico — Fascite Plantar',
    texto: `HDA: Paciente refere dor em região plantar do pé, predominando em calcâneo / inserção da fáscia plantar, pior aos primeiros passos do dia e após períodos de repouso.
Nega trauma.
Nega febre.
Nega déficit sensitivo ou motor.

EXAME FÍSICO:
Sem lesões cutâneas.
Sem deformidades evidentes.
Sem hiperemia ou sinais flogísticos importantes.
Dor à palpação da inserção da fáscia plantar no calcâneo / face plantar do retropé.
Sem dor importante à palpação das demais estruturas do pé.
Sem crepitações.
Amplitude de movimento preservada.
Força muscular preservada.
Neurovascular distal preservado.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado alongamento de cadeia posterior, medidas locais e modificação temporária de atividades de impacto.
(Instrução: incluir "Encaminhado seguimento ambulatorial" e/ou "fisioterapia" apenas se pertinente/mencionado.)
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento.
Orientado quanto a sinais de alarme e necessidade de retorno em caso de piora, limitação funcional progressiva ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e5: {
    nome: 'Crônico — Manguito Rotador / Ombralgia',
    texto: `HDA: Paciente refere dor em ombro (instrução: D/E se informado) há (instrução: tempo informado), com piora à elevação do membro e aos movimentos acima da linha do ombro.
(Instrução: incluir "Pode referir dor noturna e/ou dor para deitar sobre o lado acometido" apenas se mencionado.)
Nega trauma recente.
Nega febre ou outros sinais de alarme.
Refere (instrução: "movimentos repetitivos", "quadro crônico agudizado" ou "sem fator desencadeante definido", conforme informado).

EXAME FÍSICO:
Sem lesões cutâneas, deformidade ou sinais flogísticos importantes.
Dor à palpação de região subacromial / tuberosidade maior / face lateral do ombro.
Amplitude de movimento preservada ou limitada por dor.
Força globalmente preservada, sem déficit motor grosseiro.
(Instrução: incluir testes especiais — Jobe, Neer, Patte, Gerber — com resultado positivo/negativo, apenas os que o médico mencionou ter realizado.)
Sem déficits sensitivos ou motores no membro.
Perfusão distal preservada.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado repouso relativo e evitar atividades repetitivas / movimentos acima da linha do ombro.
(Instrução: incluir "Solicitado exame complementar ambulatorial", "encaminhado seguimento com especialista" e/ou "fisioterapia" apenas se pertinente/mencionado.)
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão das lesões de partes moles, podendo haver necessidade de reavaliação conforme evolução clínica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, perda progressiva de força, febre, limitação funcional importante ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e6: {
    nome: 'Crônico — Tendinopatia (modelo genérico)',
    texto: `HDA: Paciente refere dor em (instrução: local informado) há (instrução: tempo informado), de caráter progressivo / relacionada a esforço / relacionada a movimentos repetitivos (instrução: escolher conforme informado).
Nega trauma agudo.
Nega febre.
Nega déficit sensitivo ou motor.

EXAME FÍSICO:
Sem lesões cutâneas.
Sem deformidade evidente.
Sem sinais flogísticos exuberantes.
Dor à palpação local, com piora à mobilização do segmento e/ou à contração resistida da estrutura acometida.
Sem crepitações ou bloqueio articular.
Amplitude de movimento preservada ou discretamente limitada por dor.
Força muscular preservada.
Neurovascular distal preservado.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado repouso relativo, modificação temporária de atividades e medidas locais.
(Instrução: as linhas abaixo — USG, RX, RM, fisioterapia — são um MENU. Inclua apenas as que o médico mencionou ter solicitado ou oferecido; não invente exames não mencionados.)
Solicito USG e entrego retorno ambulatorial após o exame.
Ofereço RX e paciente decide por não realizar o exame hoje, mantendo apenas a solicitação de RM ambulatorial.
Fisioterapia.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento.
Orientado quanto a sinais de alarme e necessidade de retorno em caso de piora, sinais flogísticos importantes, déficit funcional progressivo ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  e7: {
    nome: 'Crônico — Gonalgia Não Traumática',
    texto: `HDA: Paciente refere dor crônica no joelho (instrução: D/E se informado) com piora há (instrução: tempo informado), sem trauma recente.
Refere piora à deambulação / flexão / subir e descer escadas / esforço (instrução: citar as que forem informadas).
Nega febre.
Nega sinais sistêmicos.
Nega outras queixas relevantes no momento.

EXAME FÍSICO:
Sem deformidade importante.
Sem sinais flogísticos exuberantes.
Dor à palpação da (instrução: interlinha articular / compartimento medial / compartimento lateral / região patelofemoral, conforme informado).
Sem crepitações grosseiras.
Amplitude de movimento preservada ou limitada por dor.
Sem instabilidade grosseira ao exame inicial.
Neurovascular distal preservado.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência neste momento.
Prescritas analgesia e orientações gerais.
Orientado evitar sobrecarga e atividades de impacto até melhora.
(Instrução: as linhas abaixo — RM, RX, fisioterapia — são um MENU. Inclua apenas as que o médico mencionou ter solicitado ou oferecido.)
Solicito RM e encaminho ao ambulatório para reavaliação e seguimento.
Ofereço RX e paciente decide por não realizar o exame hoje, mantendo apenas a solicitação de RM ambulatorial.
Fisioterapia.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e investigação complementar.
Orientado quanto a sinais de alarme e necessidade de retorno em caso de febre, edema importante, incapacidade funcional progressiva ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  f: {
    nome: 'Canetada Internar',
    texto: `EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura (instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido"), sem indicação de tratamento incruento, com necessidade de abordagem cirúrgica.

CONDUTA:
Caso encaminhado à equipe de retaguarda cirúrgica (instrução: cite o nome do hospital se informado pelo médico; se não informado, omita o nome do hospital e escreva apenas "à equipe de retaguarda cirúrgica").
Representada na presente data pela equipe (instrução: cite o nome do médico da retaguarda se informado; se não informado, omita esta frase inteira e sinalize no aviso do topo que o nome da equipe/médico não foi informado).
(Instrução: a linha abaixo — sobre discussão formal com a equipe de retaguarda — é OPCIONAL. Inclua apenas se o médico mencionar que discutiu o caso com a equipe; se ele apenas indicou internação sem mencionar discussão prévia, omita esta linha inteira e vá direto para "Indicada internação hospitalar...")
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

function montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante }) {
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

  if (acompanhante) {
    partes.push(`\nHISTÓRIA RELATADA POR ACOMPANHANTE: sim. Ajuste a redação da HDA e das linhas de esclarecimento/orientação para refletir que quem relatou os fatos e recebeu as orientações foi o acompanhante (ex: pai/mãe/responsável, no caso de criança; familiar/cuidador, no caso de idoso ou paciente impossibilitado), conforme instruções específicas já indicadas dentro dos modelos de referência.`);
  }

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
