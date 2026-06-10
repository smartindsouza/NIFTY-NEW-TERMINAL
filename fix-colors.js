import fs from 'fs';
import path from 'path';

const files = [
  'src/pages/OptionChain.tsx',
  'src/pages/AdvancedChart.tsx',
  'src/pages/Dashboard.tsx'
];

const patterns = [
  { p: /bg-\[#1e222d\]/g, r: 'bg-card' },
  { p: /bg-\[#151822\]/g, r: 'bg-muted' },
  { p: /bg-\[#1a1f2c\]/g, r: 'bg-popover' },
  { p: /bg-\[#1a1b23\]/g, r: 'bg-popover' },
  { p: /bg-\[#252836\]/g, r: 'bg-accent' },
  { p: /bg-\[#2a2e3d\]/g, r: 'bg-muted' },
  { p: /bg-\[#292e3d\]/g, r: 'bg-muted' },
  { p: /bg-\[#222631\]/g, r: 'bg-muted' },
  { p: /bg-\[#2a2e39\]/g, r: 'bg-muted/50' },
  { p: /bg-\[#1a1e27\]/g, r: 'bg-popover' },
  { p: /bg-slate-950/g, r: 'bg-background' },
  { p: /bg-slate-900/g, r: 'bg-card' },
  { p: /bg-\[#13151a\]/g, r: 'bg-background' },
  { p: /border-\[#2d3139\]/g, r: 'border-border' },
  { p: /border-\[#2a2e39\]/g, r: 'border-border' },
  { p: /border-slate-800/g, r: 'border-border' },
  { p: /text-\[#8e909c\]/g, r: 'text-muted-foreground' }
];

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  patterns.forEach(({ p, r }) => {
    content = content.replace(p, r);
  });
  fs.writeFileSync(file, content, 'utf8');
});

console.log('Colors fixed');
