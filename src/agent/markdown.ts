import {
  renderMarkdown,
  type IRenderMimeRegistry
} from '@jupyterlab/rendermime';

/**
 * Minimal surface of the Mermaid API we depend on. Mermaid is loaded lazily so
 * the extension bundle stays small and a missing/broken Mermaid build cannot
 * break ordinary Markdown rendering.
 */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidLoader: Promise<MermaidApi | null> | null = null;
let mermaidSequence = 0;

function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidLoader === null) {
    mermaidLoader = import('mermaid')
      .then(module => {
        const namespace = module as unknown as {
          default?: MermaidApi;
        } & MermaidApi;
        const api = (namespace.default ?? namespace) as MermaidApi;
        api.initialize({
          startOnLoad: false,
          // Model output is untrusted: strict mode escapes labels and drops
          // click handlers/scripts embedded in a diagram source.
          securityLevel: 'strict',
          theme: 'default'
        });
        return api;
      })
      .catch(() => null);
  }
  return mermaidLoader;
}

/**
 * Render ```` ```mermaid ```` fenced blocks into inline SVG diagrams.
 *
 * JupyterLab's Markdown renderer has no built-in Mermaid support, so the
 * runtime's generated charts/diagrams only appeared as raw code. Invalid
 * diagrams are left untouched instead of failing the whole answer.
 */
async function renderMermaidBlocks(host: HTMLElement): Promise<void> {
  const blocks = host.querySelectorAll<HTMLElement>(
    'pre > code.language-mermaid'
  );
  if (blocks.length === 0) {
    return;
  }
  const mermaid = await loadMermaid();
  if (!mermaid) {
    return;
  }
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement;
    const source = block.textContent ?? '';
    if (!pre || !source.trim()) {
      continue;
    }
    try {
      const id = `jp-aiterminal-mermaid-${++mermaidSequence}`;
      const { svg } = await mermaid.render(id, source);
      const container = document.createElement('div');
      container.className = 'jp-AgentWorkspace-mermaid';
      container.innerHTML = svg;
      pre.replaceWith(container);
    } catch {
      // Keep the original fenced block when the diagram is invalid.
    }
  }
}

export function renderMarkdownSource(
  host: HTMLElement,
  source: string,
  rendermime: IRenderMimeRegistry | null
): void {
  host.classList.add('jp-RenderedHTMLCommon', 'jp-RenderedMarkdown');
  if (!rendermime) {
    host.textContent = source;
    return;
  }
  // `Promise.resolve` also tolerates a synchronous/mocked renderer that does
  // not return a promise.
  void Promise.resolve(
    renderMarkdown({
      host,
      source,
      trusted: false,
      sanitizer: rendermime.sanitizer,
      resolver: rendermime.resolver,
      linkHandler: rendermime.linkHandler,
      shouldTypeset: Boolean(rendermime.latexTypesetter),
      latexTypesetter: rendermime.latexTypesetter,
      markdownParser: rendermime.markdownParser
    })
  )
    .then(() => renderMermaidBlocks(host))
    .catch(() => undefined);
}
