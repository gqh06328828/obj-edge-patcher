const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname, data = path.resolve(root, '../manual_test/v3');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.csv':'text/csv','.json':'application/json'};
http.createServer((req,res)=>{
  const u = new URL(req.url,'http://localhost');
  if(u.pathname==='/api/models') {
    const models=fs.readdirSync(data).filter(n=>n.endsWith('__edge_boundary_probability.csv')).map(n=>{
      const name=n.replace('__edge_boundary_probability.csv','');
      return {name,mesh:'/data/'+name+'__epoch09__segmented.ply',probability:'/data/'+n};
    }).filter(m=>fs.existsSync(path.join(data,path.basename(m.mesh))));
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(models));
  }
  let relative;
  try { relative=decodeURIComponent(u.pathname); } catch {res.writeHead(400);return res.end();}
  const base=relative.startsWith('/data/')?data:root;
  const file=path.resolve(base,relative.startsWith('/data/')?relative.slice(6):'.'+(relative==='/'?'/index.html':relative));
  if(!file.startsWith(base+path.sep)){res.writeHead(403);return res.end();}
  fs.stat(file,(err,stat)=>{
    if(err||!stat.isFile()){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache'});
    fs.createReadStream(file).pipe(res);
  });
}).listen(8765,'127.0.0.1',()=>console.log('Edge viewer: http://127.0.0.1:8765'));
