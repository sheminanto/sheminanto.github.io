type SearchDocument = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  date: string;
  url: string;
};

import * as model from "./model";

const dataElement = document.querySelector<HTMLScriptElement>("#search-data");
const input = document.querySelector<HTMLInputElement>("#search-input");
const searchForm = document.querySelector<HTMLFormElement>(".search");
const results = document.querySelector<HTMLElement>("#search-results");
const status = document.querySelector<HTMLElement>(".search-status");
const aiButton = document.querySelector<HTMLButtonElement>(".ai-button");
const answer = document.querySelector<HTMLElement>("#ai-answer");
const answerText = document.querySelector<HTMLElement>("#ai-answer-text");

if (dataElement && input && searchForm && results && status && aiButton && answer && answerText) {
  const logPrefix = "[nanochat]";
  const log = (...args: unknown[]) => console.info(logPrefix, ...args);
  const debug = (...args: unknown[]) => console.debug(logPrefix, ...args);
  const warn = (...args: unknown[]) => console.warn(logPrefix, ...args);
  const errorLog = (...args: unknown[]) => console.error(logPrefix, ...args);
  const documents = JSON.parse(dataElement.textContent || "[]") as SearchDocument[];
  log("search boot", { documentCount: documents.length });
  const stopWords = new Set(["a", "an", "and", "are", "as", "at", "by", "can", "do", "does", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "what", "when", "which", "why", "with"]);
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

  const editDistance = (left: string, right: string, limit: number) => {
    if (Math.abs(left.length - right.length) > limit) return limit + 1;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          current[rightIndex - 1]! + 1,
          previous[rightIndex]! + 1,
          previous[rightIndex - 1]! + cost,
        );
      }
      if (Math.min(...current) > limit) return limit + 1;
      previous = current;
    }
    return previous[right.length] ?? limit + 1;
  };

  const matchingTerms = (queryTerm: string) => {
    const indexedTerms = [...termIndex.keys()];
    const prefixMatches = indexedTerms.filter((indexedTerm) => indexedTerm.startsWith(queryTerm));
    if (prefixMatches.length || queryTerm.length < 4) return prefixMatches;
    const limit = queryTerm.length >= 7 ? 2 : 1;
    return indexedTerms.filter((indexedTerm) => editDistance(queryTerm, indexedTerm, limit) <= limit);
  };

  const search = (query: string, extraTerms: string[] = []) => {
    const queryTerms = [...new Set([...tokenize(query), ...extraTerms.flatMap(tokenize)])];
    if (!queryTerms.length) return documents.map((document) => ({ document, score: 0 }));

    const terms = [...new Set(queryTerms.flatMap(matchingTerms))];
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

  const formatContext = (matches: Array<{ document: SearchDocument; score: number }>) => matches.length ? matches.map(({ document }) => [
    `ID: ${document.id}`,
    `Title: ${document.title}`,
    `Description: ${document.description}`,
    `Tags: ${document.tags.join(", ")}`,
    "Markdown body:",
    document.body,
  ].join("\n")).join("\n\n---\n\n") : "No matching supplied content was found.";
  let answerRequest = 0;
  let prewarmedSession: Awaited<ReturnType<typeof model.createSession>> | undefined;
  let prewarmPromise: Promise<Awaited<ReturnType<typeof model.createSession>> | undefined> | undefined;
  let streaming = false;
  const createSession = () => model.createSession({
    onDownloadProgress: (fraction) => {
      if (!streaming) return;
      const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
      showAnswer(percent > 0
        ? `Downloading the model — ${percent}% of about 4 GB. Once only.`
        : "Downloading the model. Chrome reports progress in large steps.");
    },
  });

  const showAnswer = (message: string) => {
    answer.hidden = false;
    answerText.textContent = message;
  };

  const clearAnswer = () => {
    answerRequest += 1;
    if (streaming) model.stop();
    answer.hidden = true;
    answerText.textContent = "";
  };

  const updateSearch = () => {
    runSearch(input.value);
    clearAnswer();
  };

  const resultLinks = () => [...results.querySelectorAll<HTMLAnchorElement>(".story h2 a")];

  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const firstLink = resultLinks()[0];
    if (!firstLink) return;
    event.preventDefault();
    firstLink.focus();
  });

  results.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = resultLinks();
    const currentIndex = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (currentIndex < 0) return;

    event.preventDefault();
    const nextIndex = event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex >= 0 && nextIndex < links.length) {
      links[nextIndex]!.focus();
    } else if (event.key === "ArrowUp" && currentIndex === 0) {
      input.focus();
    }
  });

  input.addEventListener("input", updateSearch);
  input.addEventListener("search", updateSearch);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    updateSearch();
  });

  if (model.isSupported()) {
    log("LanguageModel API detected");
    model.checkAvailability().then((availability) => {
      log("boot availability result", availability);
      if (availability === "unavailable") return;
      aiButton.hidden = false;
      if (availability === "available") {
        prewarmPromise = createSession().then((session) => {
          log("prewarmed session ready");
          prewarmedSession = session;
          return session;
        }).catch((prewarmError) => {
          errorLog("session prewarm failed", prewarmError);
          return undefined;
        });
      }
    }).catch((bootError) => {
      errorLog("boot availability flow failed", bootError);
    });
  } else {
    warn("LanguageModel API not detected; AI button will remain hidden");
  }

  aiButton.addEventListener("click", async () => {
    const query = input.value.trim();
    if (streaming) {
      model.stop();
      return;
    }
    if (!query || !model.isSupported()) {
      if (!query) showAnswer("Ask a question about these notes.");
      return;
    }

    const request = ++answerRequest;
    log("AI request started", { request, query });
    streaming = true;
    aiButton.disabled = false;
    aiButton.textContent = "Stop";
    showAnswer("Preparing answer...");

    try {
      const availability = await model.checkAvailability();
      log("request availability result", { request, availability });
      if (request !== answerRequest) return;
      if (availability === "unavailable") {
        showAnswer("Answer unavailable.");
        return;
      }

      if (availability === "downloadable" || availability === "downloading") {
        showAnswer("Preparing the model...");
      }
      const session = prewarmedSession || (prewarmPromise ? await prewarmPromise : undefined) || await createSession();
      if (!session) throw new Error("AI session unavailable");
      log("request session ready", { request, prewarmed: Boolean(prewarmedSession) });
      try {
        const matches = search(query).slice(0, 3);
        debug("AI context selected", {
          request,
          query,
          articles: matches.map(({ document, score }) => ({ id: document.id, score })),
        });
        const prompt = `
          Answer the user's question in at most 3 concise sentences.
          Be concise and use only the supplied content below as evidence.
          Do not use general knowledge or invent facts.
          If the supplied content does not answer the question, say that the supplied notes do not cover it.
          User question: ${query}

          Supplied content:
          ${formatContext(matches)}
        `;
        let frame: number | null = null;
        let latest = "";
        const paint = () => {
          frame = null;
          if (request === answerRequest) answerText.textContent = latest;
        };
        const response = await model.send(session, prompt, (fullText) => {
          latest = fullText;
          if (request === answerRequest) {
            answer.hidden = false;
            if (frame === null) frame = requestAnimationFrame(paint);
          }
        });
        if (frame !== null) cancelAnimationFrame(frame);
        if (request === answerRequest) showAnswer(response.trim() || "Answer unavailable.");
      } finally {
        log("destroying request session", { request });
        session.destroy?.();
        if (session === prewarmedSession) prewarmedSession = undefined;
        prewarmPromise = undefined;
      }
    } catch (error) {
      errorLog("AI request failed", { request, error });
      if (request === answerRequest) {
        showAnswer(error instanceof DOMException && error.name === "AbortError"
          ? (answerText.textContent || "Generation stopped.")
          : "Answer unavailable.");
      }
    } finally {
      streaming = false;
      aiButton.disabled = false;
      aiButton.textContent = "Ask AI";
    }
  });
}
