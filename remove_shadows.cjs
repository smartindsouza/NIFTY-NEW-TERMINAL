const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir('src', function(filePath) {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.ts') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    
    // Replace shadow-sm, shadow-md, shadow-[...], etc.
    // Be careful with drop-shadow too if necessary, but the request was "remove the shadow"
    content = content.replace(/\s*\bshadow(?:-[a-zA-Z0-9\[\]_(),.%]+)?\b\s*/g, ' ');
    
    // Special fix for the OHLC box
    if (filePath.includes('AdvancedChart.tsx')) {
        content = content.replace("px-2.5 py-1.5 rounded bg-card/90", "px-2.5 py-1.5 rounded-full bg-card/90");
    }

    if (original !== content) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Updated', filePath);
    }
  }
});
