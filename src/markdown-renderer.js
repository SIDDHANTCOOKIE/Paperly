// ================================
// Markdown Renderer — Lightweight markdown to HTML
// ================================

/**
 * Converts markdown text to HTML.
 * Supports: headers, bold, italic, code blocks, inline code,
 * lists (ordered & unordered), blockquotes, links, horizontal rules
 */
export function renderMarkdown(text) {
    if (!text) return '<p style="color: var(--text-muted);">No content available.</p>';

    let html = text;

    // Escape HTML (but preserve our generated HTML later)
    html = escapeHtml(html);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // Inline code (`...`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr/>');
    html = html.replace(/^\*\*\*$/gm, '<hr/>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--accent-indigo); text-decoration: underline;">$1</a>');

    // Unordered lists
    html = html.replace(/^(\s*)[-*+] (.+)$/gm, (match, indent, content) => {
        return `<li>${content}</li>`;
    });

    // Ordered lists
    html = html.replace(/^(\s*)\d+\. (.+)$/gm, (match, indent, content) => {
        return `<li>${content}</li>`;
    });

    // Wrap consecutive <li> in <ul> or <ol>
    html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, (match) => {
        return `<ul>${match}</ul>`;
    });

    // Paragraphs - wrap text that isn't already in a tag
    const lines = html.split('\n');
    const processed = [];
    let inPre = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.includes('<pre>')) inPre = true;
        if (line.includes('</pre>')) inPre = false;

        if (inPre || !line.trim()) {
            processed.push(line);
            continue;
        }

        // Don't wrap lines that are already block-level elements
        if (/^<(h[1-6]|ul|ol|li|blockquote|pre|hr|div|table)/.test(line.trim())) {
            processed.push(line);
        } else if (line.trim() && !/<\/(h[1-6]|ul|ol|li|blockquote|pre|div|table)>$/.test(line.trim())) {
            // Only wrap if not ending a block element
            if (!line.includes('</ul>') && !line.includes('</ol>')) {
                processed.push(`<p>${line}</p>`);
            } else {
                processed.push(line);
            }
        } else {
            processed.push(line);
        }
    }

    html = processed.join('\n');

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p><\/p>/g, '');

    // Fix nested issues
    html = html.replace(/<p>(<h[1-6]>)/g, '$1');
    html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<hr\/>)/g, '$1');
    html = html.replace(/(<hr\/>)<\/p>/g, '$1');

    return html;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
