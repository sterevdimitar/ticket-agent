import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";

/**
 * Exfil-safe rendering. Chat content is model output derived from attacker-
 * controlled ticket text, so it must never be able to cause an outbound request:
 *
 *  - `img` never reaches the DOM as an image, so a markdown image never becomes a
 *    fetch. It renders as inert text naming the URL instead of vanishing: a
 *    silently dropped image leaves a description with a hole in it — "embedding
 *    the result in <gone> The customer was..." reads as ordinary prose, and the
 *    reader cannot tell a ticket tried to plant an exfil pixel. Same rule the
 *    untrusted-data delimiters follow on the server: neutralize visibly.
 *  - `a` renders as inert text with the URL shown, so the reader can see where a
 *    link claimed to go without a click ever loading it.
 *  - `skipHtml` drops raw HTML, so `<img onerror>` and friends never reach the DOM.
 *
 * The CSP in index.html (`default-src 'self'`) is the backstop under all of it.
 *
 * `remarkBreaks` turns a lone newline into a <br>, which CommonMark otherwise
 * folds into a space. A ticket listing is one line per field, so without it the
 * whole ticket renders as a run-on paragraph. This is deliberately fixed in the
 * renderer rather than by asking the model for two trailing spaces: layout that
 * depends on the model emitting invisible whitespace breaks the moment it does
 * not. It widens nothing — `br` was already the only element it can introduce,
 * and it was already allowlisted.
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkBreaks]}
      allowedElements={[
        "p",
        "strong",
        "em",
        "ul",
        "ol",
        "li",
        "code",
        "pre",
        "br",
        "span",
        // `a` and `img` are allowed only so the overrides below can intercept
        // them and render inert text. Neither reaches the DOM as itself.
        "a",
        "img",
        "h1",
        "h2",
        "h3",
        "blockquote",
      ]}
      unwrapDisallowed
      skipHtml
      components={{
        a: ({ href, children }) => (
          <span className="inert-link" title={String(href)}>
            {children} [{String(href)}]
          </span>
        ),
        // Rendered as text, never as an anchor: making the URL clickable would
        // hand back the outbound request this exists to prevent. `alt` is
        // attacker-controlled like the rest of the ticket, so it is shown as
        // the text it is, not trusted as a caption.
        // Reads "blocked image" first, because that is the fact the reader needs;
        // the alt is quoted so it is legible as text the ticket supplied rather
        // than as a field label this UI wrote. An alt of "status" rendering bare
        // under a real "Status:" line was mistaken for exactly that.
        img: ({ src, alt }) => (
          <span className="inert-image" title={String(src)}>
            [blocked image{alt ? ` "${String(alt)}"` : ""}, would have loaded {String(src)}]
          </span>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
