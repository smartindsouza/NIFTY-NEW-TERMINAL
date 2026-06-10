import fs from 'fs';

let content = fs.readFileSync('src/pages/OptionChain.tsx', 'utf8');

const patterns = [
  { p: /bg-\[#1a1c24\]/g, r: 'bg-card' },
  { p: /border-slate-700/g, r: 'border-border' },
  { p: /text-\[#4a5568\]/g, r: 'text-muted-foreground' },
  { p: /bg-\[#ef4444\]\/10/g, r: 'bg-red-500/10' },
  { p: /bg-\[#ef4444\]\/20/g, r: 'bg-red-500/20' }
];

patterns.forEach(({ p, r }) => {
  content = content.replace(p, r);
});

fs.writeFileSync('src/pages/OptionChain.tsx', content, 'utf8');

console.log('Colors fixed in OptionChain.tsx');
