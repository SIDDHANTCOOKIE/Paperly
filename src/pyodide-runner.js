// ================================
// Pyodide Runner — In-browser Python
// ================================

let pyodide = null;
let loading = false;
const loadCallbacks = [];

// ── Load Pyodide ───────────────────────────────────────

export async function ensurePyodide(onProgress) {
    if (pyodide) return pyodide;
    if (loading) {
        return new Promise((resolve) => loadCallbacks.push(resolve));
    }

    loading = true;
    if (onProgress) onProgress('Loading Python runtime…');

    // Load Pyodide script
    if (!window.loadPyodide) {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
        document.head.appendChild(script);
        await new Promise((ok, no) => { script.onload = ok; script.onerror = no; });
    }

    if (onProgress) onProgress('Initializing Python…');
    pyodide = await window.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
    });

    // Pre-install common packages
    if (onProgress) onProgress('Installing packages…');
    await pyodide.loadPackage(['numpy', 'matplotlib', 'micropip']);

    // Setup matplotlib for inline rendering
    await pyodide.runPythonAsync(`
import matplotlib
matplotlib.use('AGG')
import matplotlib.pyplot as plt
import io, base64

def _paperly_show():
    buf = io.BytesIO()
    plt.savefig(buf, format='png', dpi=100, bbox_inches='tight',
                facecolor='#0d0d0d', edgecolor='none')
    plt.close('all')
    buf.seek(0)
    return base64.b64encode(buf.read()).decode('utf-8')
  `);

    loading = false;
    loadCallbacks.forEach((cb) => cb(pyodide));
    loadCallbacks.length = 0;

    return pyodide;
}

// ── Run a code cell ────────────────────────────────────

export async function runCell(code, onProgress) {
    const py = await ensurePyodide(onProgress);

    // Auto-install packages via micropip if needed
    const imports = detectImports(code);
    if (imports.length > 0) {
        for (const pkg of imports) {
            try {
                await py.runPythonAsync(`import ${pkg}`);
            } catch {
                if (onProgress) onProgress(`Installing ${pkg}…`);
                try {
                    // Try loading as a pyodide package first
                    await py.loadPackage(pkg);
                } catch {
                    // Fall back to micropip
                    try {
                        await py.runPythonAsync(`import micropip; await micropip.install('${pkg}')`);
                    } catch (e) {
                        // Package not available — will error when code runs
                    }
                }
            }
        }
    }

    // Capture stdout/stderr
    await py.runPythonAsync(`
import sys, io
_paperly_stdout = io.StringIO()
_paperly_stderr = io.StringIO()
sys.stdout = _paperly_stdout
sys.stderr = _paperly_stderr
  `);

    let result = { stdout: '', stderr: '', plots: [], error: null };

    try {
        // Check if code has plt.show() — replace with our capture
        const patchedCode = code.replace(/plt\.show\(\)/g, '_paperly_plot_data = _paperly_show()');

        await py.runPythonAsync(patchedCode);

        // Get stdout
        result.stdout = py.runPython('_paperly_stdout.getvalue()');
        result.stderr = py.runPython('_paperly_stderr.getvalue()');

        // Check for plot
        try {
            const plotData = py.runPython(`
try:
    _paperly_plot_data
except NameError:
    ''
      `);
            if (plotData) {
                result.plots.push(plotData);
                py.runPython('del _paperly_plot_data');
            }
        } catch { /* no plot */ }

        // Also check if there are any open figures
        try {
            const hasOpenFig = py.runPython(`
import matplotlib.pyplot as plt
len(plt.get_fignums()) > 0
      `);
            if (hasOpenFig) {
                const plotData = py.runPython('_paperly_show()');
                if (plotData) result.plots.push(plotData);
            }
        } catch { /* no matplotlib */ }

    } catch (err) {
        result.error = err.message;
        // Still get any stdout that was produced before the error
        try { result.stdout = py.runPython('_paperly_stdout.getvalue()'); } catch { }
        try { result.stderr = py.runPython('_paperly_stderr.getvalue()'); } catch { }
    }

    // Restore stdout/stderr
    await py.runPythonAsync(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
  `);

    return result;
}

// ── Detect imports ─────────────────────────────────────

function detectImports(code) {
    const pkgs = new Set();
    const lines = code.split('\n');
    for (const line of lines) {
        const m1 = line.match(/^\s*import\s+(\w+)/);
        const m2 = line.match(/^\s*from\s+(\w+)/);
        if (m1) pkgs.add(m1[1]);
        if (m2) pkgs.add(m2[1]);
    }
    // Remove builtins
    const builtins = new Set(['sys', 'os', 'io', 'math', 'json', 'csv', 're', 'collections',
        'itertools', 'functools', 'typing', 'pathlib', 'datetime', 'time', 'random',
        'string', 'textwrap', 'copy', 'pprint', 'warnings', 'abc', 'base64',
        'hashlib', 'struct', 'operator', 'contextlib', 'dataclasses', 'enum']);
    builtins.forEach((b) => pkgs.delete(b));
    return [...pkgs];
}
