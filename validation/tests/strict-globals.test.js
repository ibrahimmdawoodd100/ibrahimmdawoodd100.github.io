'use strict';
// Static guard: in a 'use strict' browser script, assigning to a name that no earlier script
// declared throws at load time and silently stops the rest of the file (the v5.2.1 seller bug).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const acorn = require('acorn');
const root = path.join(__dirname, '..', 'public');
const PAGES = ['seller.html', 'manager/index.html', 'employee/index.html', 'manager/diagnostics.html'];
const EXTERNAL = new Set(['firebase', 'L']);
const BROWSER = new Set(['onload', 'onerror', 'onresize', 'onbeforeunload', 'onpopstate', 'onhashchange', 'onfocus', 'onblur', 'onmessage', 'location', 'name', 'status', 'onunload', 'onpageshow', 'onpagehide', 'onvisibilitychange', 'onstorage', 'ononline', 'onoffline']);

function scripts(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8'), out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /src="([^"]+)"/.exec(m[1]);
    if (src) { if (/^https?:/.test(src[1])) continue; out.push({ label: src[1], code: fs.readFileSync(path.join(root, src[1].replace(/^\/manager\/assets\//, 'assets/').replace(/^\//, '')), 'utf8') }); }
    else if (m[2].trim()) out.push({ label: `${page} inline`, code: m[2] });
  }
  return out;
}
const isFn = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
function names(p, acc = []) {
  if (!p) return acc;
  if (p.type === 'Identifier') acc.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach(x => names(x.type === 'RestElement' ? x.argument : x.value, acc));
  else if (p.type === 'ArrayPattern') p.elements.forEach(x => names(x, acc));
  else if (p.type === 'RestElement') names(p.argument, acc);
  else if (p.type === 'AssignmentPattern') names(p.left, acc);
  return acc;
}
function each(n, fn) { for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && fn(c)); else if (v && typeof v.type === 'string') fn(v); } }
function declared(node) {
  const acc = new Set();
  (function visit(n) {
    if (n.type === 'VariableDeclaration') n.declarations.forEach(d => names(d.id).forEach(x => acc.add(x)));
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) acc.add(n.id.name);
    if (n.type === 'CatchClause' && n.param) names(n.param).forEach(x => acc.add(x));
    if (isFn(n) && n !== node) return;
    each(n, visit);
  })(node);
  return acc;
}
function windowProps(ast) {
  const acc = new Set();
  (function visit(n) {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type === 'Identifier' && ['window', 'globalThis', 'self'].includes(n.left.object.name)) acc.add(n.left.property.name);
    each(n, visit);
  })(ast);
  return acc;
}
function assignments(ast, found) {
  (function visit(n, scopes, depth) {
    if (isFn(n)) {
      const s = n.body.type === 'BlockStatement' ? declared(n.body) : new Set();
      n.params.forEach(p => names(p).forEach(x => s.add(x)));
      if (n.type === 'FunctionExpression' && n.id) s.add(n.id.name);
      s.add('arguments');
      const inner = [...scopes, s];
      n.params.forEach(p => visit(p, inner, depth + 1)); visit(n.body, inner, depth + 1);
      return;
    }
    const check = id => { if (!scopes.some(s => s.has(id))) found(id, depth === 0, n.loc.start.line); };
    if (n.type === 'AssignmentExpression') { if (n.left.type === 'Identifier') check(n.left.name); else if (n.left.type !== 'MemberExpression') names(n.left).forEach(check); }
    if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier') check(n.argument.name);
    if ((n.type === 'ForInStatement' || n.type === 'ForOfStatement') && n.left.type === 'Identifier') check(n.left.name);
    each(n, c => visit(c, scopes, depth));
  })(ast, [], 0);
}

for (const page of PAGES) {
  test(`no strict-mode assignment to an undeclared global: ${page}`, () => {
    const parsed = scripts(page).map(s => {
      const ast = acorn.parse(s.code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
      return { ...s, ast, strict: ast.body[0]?.directive === 'use strict', decl: declared(ast), win: windowProps(ast) };
    });
    const all = new Set(EXTERNAL); parsed.forEach(p => { p.decl.forEach(x => all.add(x)); p.win.forEach(x => all.add(x)); });
    const soFar = new Set(EXTERNAL), problems = [];
    for (const p of parsed) {
      p.decl.forEach(x => soFar.add(x));
      if (p.strict) assignments(p.ast, (id, top, line) => { if (!BROWSER.has(id) && !(top ? soFar : all).has(id)) problems.push(`${p.label}:${line} ${id}${top ? ' (top level: file stops loading)' : ''}`); });
      p.win.forEach(x => soFar.add(x));
    }
    assert.deepEqual(problems, []);
  });
}

test('the guard catches the original v5.2.1 seller bug', () => {
  const ast = acorn.parse("'use strict';\ncountCompanyEmployees = async function() {};", { ecmaVersion: 'latest', locations: true });
  const problems = []; assignments(ast, (id, top) => problems.push([id, top]));
  assert.deepEqual(problems, [['countCompanyEmployees', true]]);
});
