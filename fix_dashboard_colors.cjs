const fs = require('fs');
let content = fs.readFileSync('src/pages/Dashboard.tsx', 'utf8');

content = content.replace(/text-\[\#3b82f6\]/g, 'text-primary');
content = content.replace(/bg-\[\#3b82f6\]\/10/g, 'bg-primary/10');

content = content.replace(/text-\[\#ef4444\]/g, 'text-primary');
content = content.replace(/bg-\[\#ef4444\]\/10/g, 'bg-primary/10');

content = content.replace(/text-\[\#22c55e\]/g, 'text-primary');
content = content.replace(/bg-\[\#22c55e\]\/10/g, 'bg-primary/10');

content = content.replace(/text-\[\#eab308\]/g, 'text-primary');
content = content.replace(/bg-\[\#eab308\]\/10/g, 'bg-primary/10');

content = content.replace(/text-yellow-500/g, 'text-primary');

fs.writeFileSync('src/pages/Dashboard.tsx', content);
