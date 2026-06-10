import * as fs from 'fs';
import * as path from 'path';

function replaceColorsInFile(filePath: string) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // common hardcoded dark colors -> semantic
  content = content.replace(/bg-\[#0d1117\]/g, 'bg-card');
  content = content.replace(/bg-\[#0d131f\]/g, 'bg-card');
  content = content.replace(/bg-\[#161b22\]/g, 'bg-muted');
  content = content.replace(/bg-\[#1c1e26\]/g, 'bg-muted');
  content = content.replace(/bg-\[#0f1422\]/g, 'bg-card');
  content = content.replace(/text-white\/10/g, 'text-muted-foreground/30');
  content = content.replace(/text-white\/50/g, 'text-muted-foreground');
  content = content.replace(/border-white\/10/g, 'border-border');
  content = content.replace(/border-white\/5/g, 'border-border/50');
  content = content.replace(/hover:bg-white\/5/g, 'hover:bg-accent hover:text-accent-foreground');
  content = content.replace(/bg-transparent hover:bg-white\/10/g, 'bg-transparent hover:bg-accent');
  content = content.replace(/text-slate-400/g, 'text-muted-foreground');
  content = content.replace(/text-slate-300/g, 'text-foreground/80');
  content = content.replace(/text-slate-200/g, 'text-foreground/90');
  content = content.replace(/text-slate-500/g, 'text-muted-foreground');
  content = content.replace(/text-white/g, 'text-foreground');
  content = content.replace(/bg-black\/40/g, 'bg-muted');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${filePath}`);
  }
}

function walkDirs(dir: string) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDirs(fullPath);
    } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      replaceColorsInFile(fullPath);
    }
  }
}

walkDirs(path.join(process.cwd(), 'src'));
