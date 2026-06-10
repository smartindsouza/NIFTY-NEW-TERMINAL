import fs from 'fs';
import path from 'path';

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? 
      walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir('src/', function(filePath) {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    // Remove heavy shadows
    content = content.replace(/shadow-\[inset_0_1px_rgba\(255,255,255,0\.05\),0_8px_32px_rgba\(0,0,0,0\.4\)\]/g, 'shadow-sm');
    content = content.replace(/shadow-2xl/g, 'shadow-sm');
    content = content.replace(/shadow-xl/g, 'shadow-sm');
    content = content.replace(/shadow-md/g, 'shadow-sm');

    // Remove border utility classes that look like card borders
    content = content.replace(/border-border\/50/g, 'border-0');
    content = content.replace(/border-border\/10/g, 'border-0');
    content = content.replace(/border-border/g, 'border-0');
    content = content.replace(/border-slate-700\/50/g, 'border-none');
    content = content.replace(/border-slate-800\/60/g, '');
    content = content.replace(/border-slate-[0-9]{3}/g, '');

    // The prompt: "make the corners rounded for every search box in the entire app"
    // I already did SymbolSearch, are there other search boxes?
    
    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
});
console.log('Shadows and borders cleaned up');
