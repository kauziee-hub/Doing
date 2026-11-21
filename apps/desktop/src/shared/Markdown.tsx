import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1];
  const code = textOf(children).replace(/\n$/, '');
  return (
    <div className="vc-code">
      <div className="vc-code__bar">
        <span className="vc-code__lang">{lang ?? 'code'}</span>
        <button
          type="button"
          className="vc-code__copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

/**
 * Safe Markdown: react-markdown never renders raw HTML (no rehype-raw), links
 * are rendered inert (opening arbitrary URLs from model output is not allowed).
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="vc-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        skipHtml
        components={{
          a: ({ children }) => <span className="vc-md__link">{children}</span>,
          img: () => null,
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
            return <CodeBlock className={props.className}>{props.children}</CodeBlock>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
