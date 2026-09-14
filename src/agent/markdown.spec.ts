import { renderMarkdownSource } from './markdown';

jest.mock('@jupyterlab/rendermime', () => ({
  renderMarkdown: jest.fn()
}));

describe('renderMarkdownSource', () => {
  it('falls back to text when rendermime is missing', () => {
    const host = document.createElement('div');
    renderMarkdownSource(host, '# Hello', null);
    expect(host.textContent).toBe('# Hello');
    expect(host.classList.contains('jp-RenderedMarkdown')).toBe(true);
    expect(host.classList.contains('jp-RenderedHTMLCommon')).toBe(true);
  });
});
