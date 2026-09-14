import {
  renderMarkdown,
  type IRenderMimeRegistry
} from '@jupyterlab/rendermime';

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
  void renderMarkdown({
    host,
    source,
    trusted: false,
    sanitizer: rendermime.sanitizer,
    resolver: rendermime.resolver,
    linkHandler: rendermime.linkHandler,
    shouldTypeset: Boolean(rendermime.latexTypesetter),
    latexTypesetter: rendermime.latexTypesetter,
    markdownParser: rendermime.markdownParser
  });
}
