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
  availability: () => Promise<string>;
  create: (options?: { initialPrompts?: Array<{ role: string; content: string }> }) => Promise<{
    prompt: (input: string) => Promise<string>;
    destroy?: () => void;
  }>;
};

const dataElement = document.querySelector<HTMLScriptElement>("#search-data");
const input = document.querySelector<HTMLInputElement>("#search-input");
const results = document.querySelector<HTMLElement>("#search-results");
const status = document.querySelector<HTMLElement>(".search-status");
const aiButton = document.querySelector<HTMLButtonElement>(".ai-button");

if (dataElement && input && results && status && aiButton) {
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
  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("search", () => runSearch(input.value));

  const languageModel = (window as Window & { LanguageModel?: LanguageModelApi }).LanguageModel;
  if (languageModel) {
    languageModel.availability().then((availability) => {
      if (availability !== "unavailable") aiButton.hidden = false;
    }).catch(() => {});
  }

  aiButton.addEventListener("click", async () => {
    const query = input.value.trim();
    if (!query || !languageModel) return;
    aiButton.disabled = true;
    aiButton.textContent = "Thinking...";
    try {
      const availability = await languageModel.availability();
      if (availability === "unavailable") throw new Error("AI unavailable");
      const session = await languageModel.create({
        initialPrompts: [{ role: "system", content: "Return only a comma-separated list of up to five concise search terms. Do not explain your answer." }],
      });
      const context = documents.map((document) => `${document.id}: ${document.title} - ${document.description} - ${document.tags.join(", ")}`).join("\n");
      const response = await session.prompt(`Query: ${query}\nAvailable notes:\n${context}`);
      session.destroy?.();
      runSearch(query, response.split(",").map((term) => term.trim()).filter(Boolean));
    } catch {
      runSearch(query);
    } finally {
      aiButton.disabled = false;
      aiButton.textContent = "Ask AI";
    }
  });
}
