// ================================
// Notebook Generator — Create .ipynb files
// ================================

/**
 * Generate a proper .ipynb notebook structure
 */
export function generateColabNotebook(cells) {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
            kernelspec: {
                display_name: 'Python 3',
                language: 'python',
                name: 'python3',
            },
            language_info: {
                name: 'python',
                version: '3.10.0',
                mimetype: 'text/x-python',
                codemirror_mode: {
                    name: 'ipython',
                    version: 3,
                },
                pygments_lexer: 'ipython3',
                file_extension: '.py',
            },
            colab: {
                provenance: [],
                name: 'Paperly - Paper Implementation',
            },
        },
        cells: cells.map((cell, i) => ({
            cell_type: cell.type || 'code',
            metadata: cell.type === 'markdown' ? {} : {
                execution_count: null,
            },
            source: Array.isArray(cell.source) ? cell.source : [cell.source],
            outputs: [],
            ...(cell.type === 'code' ? { execution_count: null } : {}),
        })),
    };
}

/**
 * Download a notebook as .ipynb file
 */
export function downloadNotebook(notebook, title = 'paper_implementation') {
    const filename = sanitizeFilename(title) + '.ipynb';
    const json = JSON.stringify(notebook, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 60);
}
