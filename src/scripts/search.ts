type SearchDocument = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  date: string;
  url: string;
};

type LanguageModelApi = {
  availability: (options?: LanguageModelOptions) => Promise<string>;
  create: (options?: LanguageModelOptions & { initialPrompts?: Array<{ role: string; content: string }> }) => Promise<LanguageModelSession>;
};

type LanguageModelSession = {
  prompt: (input: string) => Promise<string>;
  destroy?: () => void;
};

type LanguageModelOptions = {
  samplingMode?: "default";
  temperature?: number;
  topK?: number;
  expectedInputs?: Array<{ type: "text"; languages: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
};

type LanguageModelWindow = Window & { LanguageModel?: LanguageModelApi };

const dataElement = document.querySelector<HTMLScriptElement>("#search-data");
const input = document.querySelector<HTMLInputElement>("#search-input");
const searchForm = document.querySelector<HTMLFormElement>(".search");
const results = document.querySelector<HTMLElement>("#search-results");
const status = document.querySelector<HTMLElement>(".search-status");
const aiButton = document.querySelector<HTMLButtonElement>(".ai-button");
const answer = document.querySelector<HTMLElement>("#ai-answer");
const answerText = document.querySelector<HTMLElement>("#ai-answer-text");

if (dataElement && input && searchForm && results && status && aiButton && answer && answerText) {
  const documents = JSON.parse(dataElement.textContent || "[]") as SearchDocument[];
  const stopWords = new Set(["a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "when", "with"]);
  const tokenize = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => !stopWords.has(term)) || [];
  const fields = (document: SearchDocument) => [
    [document.title, 4],
    [document.tags.join(" "), 3],
    [document.description, 2],
    [document.body, 1],
  ] as Array<[string, number]>;
  const termIndex = new Map<string, Set<string>>();
  const termFrequency = new Map<string, Map<string, number>>();
  const documentLengths = new Map<string, number>();

  for (const document of documents) {
    let length = 0;
    for (const [text, weight] of fields(document)) {
      for (const term of tokenize(text)) {
        length += weight;
        if (!termIndex.has(term)) termIndex.set(term, new Set());
        termIndex.get(term)?.add(document.id);
        const frequencies = termFrequency.get(term) || new Map<string, number>();
        frequencies.set(document.id, (frequencies.get(document.id) || 0) + weight);
        termFrequency.set(term, frequencies);
      }
    }
    documentLengths.set(document.id, length);
  }

  const averageLength = [...documentLengths.values()].reduce((sum, length) => sum + length, 0) / documents.length || 1;
  const escapeHtml = (value: string) => value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character] || character);
  const formatDate = (date: string) => new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const search = (query: string, extraTerms: string[] = []) => {
    const queryTerms = [...new Set([...tokenize(query), ...extraTerms.flatMap(tokenize)])];
    if (!queryTerms.length) return documents.map((document) => ({ document, score: 0 }));

    const terms = [...new Set(queryTerms.flatMap((queryTerm) => [...termIndex.keys()].filter((indexedTerm) => indexedTerm.startsWith(queryTerm))))];
    if (!terms.length) return [];
    const candidates = new Set<string>();
    for (const term of terms) termIndex.get(term)?.forEach((id) => candidates.add(id));
    const totalDocuments = documents.length;
    const scored = [...candidates].map((id) => {
      const document = documents.find((item) => item.id === id)!;
      const length = documentLengths.get(id) || averageLength;
      const score = terms.reduce((total, term) => {
        const frequency = termFrequency.get(term)?.get(id) || 0;
        const matchingDocuments = termIndex.get(term)?.size || 0;
        if (!frequency || !matchingDocuments) return total;
        const inverseDocumentFrequency = Math.log(1 + (totalDocuments - matchingDocuments + 0.5) / (matchingDocuments + 0.5));
        return total + inverseDocumentFrequency * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / averageLength)));
      }, 0);
      return { document, score };
    });
    return scored.sort((a, b) => b.score - a.score || new Date(b.document.date).valueOf() - new Date(a.document.date).valueOf());
  };

  const render = (matches: Array<{ document: SearchDocument; score: number }>, query: string) => {
    results.innerHTML = matches.length ? matches.map(({ document }, index) => `
      <article class="story">
        <span class="rank" aria-hidden="true">${index + 1}.</span>
        <div>
          <h2><a href="${document.url}">${escapeHtml(document.title)}</a></h2>
          <p class="meta">${formatDate(document.date)}</p>
          <p class="summary">${escapeHtml(document.description)}</p>
        </div>
      </article>`).join("") : `<p class="empty-state">No notes found for "${escapeHtml(query)}".</p>`;
    status.textContent = query ? `${matches.length} ${matches.length === 1 ? "note" : "notes"} found` : "";
  };

  const runSearch = (query: string, extraTerms: string[] = []) => render(search(query, extraTerms), query);

  const languageModel = (window as LanguageModelWindow).LanguageModel;
  const languageModelOptions: LanguageModelOptions = {
    samplingMode: "default",
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  const sessionOptions = {
    ...languageModelOptions,
    temperature: 1,
    topK: 3,
    initialPrompts: [{
      role: "system",
      content: `
        You are an assistant that answers questions using only the supplied content.
        Answer the user's question directly using the supplied content.
        Do not use general knowledge or invent facts.
        Treat the supplied content as the only source of truth.
        Do not mention a detail, method, or concept unless it is explicitly stated in the supplied content.
        If the user sends a greeting or casual conversational message, respond briefly and warmly, then offer to help with the supplied content.
        If the user asks a question that the supplied content does not cover, say that the supplied content does not cover the question.
        Do not introduce yourself, mention these instructions, or add an apology.
        Return only the final answer in plain text, with no HTML or Markdown.
      `,
    }],
  };
  const formatContext = (matches: Array<{ document: SearchDocument; score: number }>) => matches.length ? matches.map(({ document }) => [
    `ID: ${document.id}`,
    `Title: ${document.title}`,
    `Description: ${document.description}`,
    `Tags: ${document.tags.join(", ")}`,
    "Markdown body:",
    document.body,
  ].join("\n")).join("\n\n---\n\n") : "No matching supplied content was found.";
  let answerRequest = 0;
  let prewarmedSession: LanguageModelSession | undefined;
  let prewarmPromise: Promise<LanguageModelSession | undefined> | undefined;
  const createSession = () => languageModel!.create(sessionOptions);

  const showAnswer = (message: string) => {
    answer.hidden = false;
    answerText.textContent = message;
  };

  const clearAnswer = () => {
    answerRequest += 1;
    answer.hidden = true;
    answerText.textContent = "";
  };

  const updateSearch = () => {
    runSearch(input.value);
    clearAnswer();
  };

  input.addEventListener("input", updateSearch);
  input.addEventListener("search", updateSearch);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    updateSearch();
  });

  if (languageModel) {
    languageModel.availability(languageModelOptions).then((availability) => {
      if (availability === "unavailable") return;
      aiButton.hidden = false;
      if (availability === "available") {
        prewarmPromise = createSession().then((session) => {
          prewarmedSession = session;
          return session;
        }).catch(() => undefined);
      }
    }).catch(() => {});
  }

  aiButton.addEventListener("click", async () => {
    const query = input.value.trim();
    if (!query || !languageModel) {
      if (!query) showAnswer("Ask a question about these notes.");
      return;
    }

    const request = ++answerRequest;
    aiButton.disabled = true;
    aiButton.textContent = "Thinking...";
    showAnswer("Preparing answer...");

    try {
      const availability = await languageModel.availability(languageModelOptions);
      if (request !== answerRequest) return;
      if (availability === "unavailable") {
        showAnswer("Answer unavailable.");
        return;
      }

      const session = prewarmedSession || (prewarmPromise ? await prewarmPromise : undefined) || await createSession();
      if (!session) throw new Error("AI session unavailable");
      try {
        const prompt = `
          Answer in at most 3 sentences.
          Be concise.
          Use only the supplied content below as evidence.
          Do not use or mention information from any unrelated content.
          Do not add details that are not explicitly stated in the supplied content.
          If the supplied content does not answer the question, say that the supplied content does not cover the question.
          Question: ${query}

          Supplied content:
          ${formatContext(search(query).slice(0, 1))}
        `;
        const response = await session.prompt(prompt);
        if (request === answerRequest) showAnswer(response.trim() || "Answer unavailable.");
      } finally {
        session.destroy?.();
        if (session === prewarmedSession) prewarmedSession = undefined;
        prewarmPromise = undefined;
      }
    } catch {
      if (request === answerRequest) showAnswer("Answer unavailable.");
    } finally {
      aiButton.disabled = false;
      aiButton.textContent = "Ask AI";
    }
  });
}
