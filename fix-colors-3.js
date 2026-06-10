import fs from 'fs';

const files = [
  'src/components/SymbolSearch.tsx',
  'src/pages/Notifications.tsx',
  'src/pages/AdvancedChart.tsx',
  'src/pages/News.tsx'
];

const patterns = [
  { p: /bg-slate-800/g, r: 'bg-muted' },
  { p: /bg-slate-950/g, r: 'bg-background' },
  { p: /bg-slate-900/g, r: 'bg-card' },
  { p: /bg-[#252836]/g, r: 'bg-accent' },
  { p: /hover:bg-[#252836]/g, r: 'hover:bg-accent' }
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    patterns.forEach(({ p, r }) => {
      content = content.replace(p, r);
    });
    fs.writeFileSync(file, content, 'utf8');
  }
});

console.log('Colors fixed');
