// Extracts the demo's synthetic data + lesson into JSON (regex literals -> {source, flags}).
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const start = html.findIndex(l => l.startsWith('/* ============ Synthetic demo data'));
const end = html.findIndex(l => l.startsWith('/* ============ Spoken lines'));
let src = html.slice(start, end).join('\n');
// logos
const logo = (name) => { const m = html.find(l => l.startsWith(`const ${name}=`)); return m ? m.split("'")[1] : null; };
const names = ['FACULTIES','PROGRAMMES','STAFF','COURSES','MODULES','STUDENTS','ENROL','COURSE_SIZE','COURSE_COMPLETION','COURSE_AVG','SAGAR_PROGRESS','ASSESSMENTS','QUIZ','SUBMISSIONS','ANNOUNCEMENTS','THREADS','EVENTS','FAQ','SUPPORT_TICKETS','AVATARS','LESSON','VF_BASE','AUDIT','DEMO_STUDENT_IDS'];
src += '\n;globalThis.__out = {' + names.map(n => `${n}: typeof ${n}!=='undefined'?${n}:null`).join(',') + '};';
const ctx = { Date, Math, console, Object, Array, String, Number, JSON };
vm.createContext(ctx); vm.runInContext(src, ctx);
const out = JSON.parse(JSON.stringify(ctx.__out, (k, v) => v instanceof RegExp || (v && v.constructor && v.constructor.name === 'RegExp') ? { re: v.source, flags: v.flags } : v));
for (const a of out.AVATARS) delete a.look;
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
for (const [n, f] of [['LOGO_UOM', 'uom'], ['LOGO_HIB', 'hibilter']]) { const d = logo(n); if (d) { const [h, b] = d.split(','); const ext = h.includes('svg') ? 'svg' : h.includes('png') ? 'png' : 'jpg'; fs.writeFileSync(`${process.argv[4]}/${f}.${ext}`, Buffer.from(b, 'base64')); } }
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : v])));
