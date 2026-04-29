const fs = require('fs');
const path = require('path');
const loadTypescript = () => {
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'typescript'),
    path.join(process.cwd(), 'client', 'node_modules', 'typescript'),
    path.join(process.cwd(), 'server', 'node_modules', 'typescript'),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next location
    }
  }

  throw new Error('Unable to resolve TypeScript from root/client/server node_modules');
};

const ts = loadTypescript();

const ROOT = process.cwd();
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const skipDirs = new Set(['node_modules', '.git', 'client/build', 'tools']);

const shouldSkipPath = (p) => {
  const normalized = p.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/')) return true;
  if (normalized.includes('/.git/')) return true;
  if (normalized.includes('/client/build/')) return true;
  if (normalized.includes('/tools/')) return true;
  return false;
};

const allFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if ([...skipDirs].some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
      walk(full);
      continue;
    }
    if (!exts.has(path.extname(entry.name))) continue;
    if (shouldSkipPath(full)) continue;
    allFiles.push(full);
  }
};

walk(ROOT);

const sourceKindForFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js') return ts.ScriptKind.JS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
};

const getCallExpression = (expr) => {
  if (ts.isCallExpression(expr)) return expr;
  if (ts.isAwaitExpression(expr) && ts.isCallExpression(expr.expression)) return expr.expression;
  return null;
};

const isConsoleCall = (callExpr) => {
  const callee = callExpr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return ts.isIdentifier(callee.expression) && callee.expression.text === 'console';
};

const isMeasureCall = (callExpr) => {
  if (!ts.isIdentifier(callExpr.expression)) return false;
  return callExpr.expression.text === 'measureOperation' || callExpr.expression.text === 'measureSyncOperation';
};

let changedCount = 0;

for (const filePath of allFiles) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, sourceKindForFile(filePath));

  const replacements = [];

  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      const callExpr = getCallExpression(node.expression);
      if (callExpr && isConsoleCall(callExpr)) {
        replacements.push({ start: node.getFullStart(), end: node.getEnd(), text: '' });
      }
    }

    if (ts.isCallExpression(node) && isMeasureCall(node)) {
      const fn = node.arguments[1];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const fnText = text.slice(fn.getStart(sf), fn.getEnd());
        replacements.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: `(${fnText})()`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  if (replacements.length === 0) continue;

  replacements.sort((a, b) => b.start - a.start);
  let next = text;
  for (const r of replacements) {
    next = next.slice(0, r.start) + r.text + next.slice(r.end);
  }

  if (next !== text) {
    fs.writeFileSync(filePath, next, 'utf8');
    changedCount += 1;
  }
}
