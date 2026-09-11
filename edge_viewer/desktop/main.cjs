const {app,BrowserWindow,Menu,dialog,ipcMain,protocol,net,session}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const portableRoot=app.isPackaged?path.dirname(process.execPath):root;
const userData=path.join(portableRoot,'user-data');
fs.mkdirSync(userData,{recursive:true});
app.setPath('userData',userData);
app.setPath('sessionData',path.join(userData,'session'));
app.setName('EdgeScope');
app.setAppUserModelId('local.edgescope.viewer');
protocol.registerSchemesAsPrivileged([{scheme:'edgescope',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
let win,directory,settings={},readoutProcess=null;
const configPath=path.join(userData,'preferences.json');
try{settings=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{}
const allowedFiles=new Map();
function expose(file){const id=randomUUID();allowedFiles.set(id,file);return {name:path.basename(file),url:'edgescope://app/data/'+id};}
function stem(file){return path.basename(file).replace(/__epoch\d+__segmented\.ply$/i,'').replace(/\.(obj|ply)$/i,'');}
function probabilityFor(file){
  const base=stem(file),folder=path.dirname(file);
  for(const name of [base+'__edge_boundary_probability',base])for(const ext of ['.csv','.xlsx','.xls']){
    const candidate=path.join(folder,name+ext);if(fs.existsSync(candidate))return candidate;
  }
  return null;
}
async function listModels(folder){
  if(!folder||!fs.existsSync(folder))return [];
  const entries=await fsp.readdir(folder);
  const candidates=entries.filter(n=>/\.(obj|ply)$/i.test(n)).sort((a,b)=>Number(/\.ply$/i.test(a))-Number(/\.ply$/i.test(b))||a.localeCompare(b));
  const models=[],used=new Set();
  for(const name of candidates){
    const file=path.join(folder,name),prob=probabilityFor(file),base=stem(file);
    if(!prob||used.has(base))continue;used.add(base);
    models.push({name:base,mesh:expose(file).url,probability:expose(prob).url,meshName:name,probabilityName:path.basename(prob)});
  }
  return models;
}
function saveSettings(){fs.writeFileSync(configPath,JSON.stringify(settings,null,2));}
function trusted(event){if(event.sender!==win?.webContents||event.senderFrame?.url!=='edgescope://app/index.html')throw Error('Unknown application sender');}
function command(name){win?.webContents.send('viewer-command',name);}
const owner=()=>win;
function registerIPC(){
  ipcMain.handle('choose-segmentation',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择读出结果 segmentation.json',properties:['openFile'],filters:[{name:'分片标签',extensions:['json']}]});
    if(result.canceled)return null;
    return JSON.parse(await fsp.readFile(result.filePaths[0],'utf8'));
  });
  ipcMain.handle('cancel-readout',event=>{trusted(event);if(readoutProcess)readoutProcess.kill();});
  ipcMain.handle('run-readout',async(event,options)=>{
    trusted(event);if(readoutProcess)throw Error('已有读出任务正在运行。');
    const resolveURL=value=>{const u=new URL(value);if(u.protocol!=='edgescope:'||u.hostname!=='app'||!u.pathname.startsWith('/data/'))throw Error('请先选择模型和概率表。');const file=allowedFiles.get(u.pathname.slice(6));if(!file)throw Error('文件授权已失效，请重新选择。');return file;};
    const mesh=resolveURL(options.mesh),probability=resolveURL(options.probability);
    const minFaces=Number(options.minFaces),minArea=Number(options.minArea),normalSigma=Number(options.normalSigma);
    if(!Number.isInteger(minFaces)||minFaces<1||!Number.isFinite(minArea)||minArea<0||minArea>1||!Number.isFinite(normalSigma)||normalSigma<.05||normalSigma>1)throw Error('读出参数无效。');
    const python=path.join(process.resourcesPath,'python','python.exe');
    const script=path.join(process.resourcesPath,'readout','geometry_readout.py');
    if(!fs.existsSync(python)||!fs.existsSync(script))throw Error('未找到随软件打包的读出运行库，请运行新版完整软件。');
    const choice=await dialog.showOpenDialog(owner(),{title:'选择分片结果的保存文件夹（将自动创建新的结果子文件夹）',defaultPath:settings.outputDirectory||path.dirname(mesh),properties:['openDirectory','createDirectory']});
    if(choice.canceled)return null;
    settings.outputDirectory=choice.filePaths[0];saveSettings();
    const out=path.join(choice.filePaths[0],stem(mesh)+'_readout_'+new Date().toISOString().replace(/[:.]/g,'-'));
    await fsp.mkdir(out,{recursive:true});let probabilityCSV=probability;
    if(!/\.csv$/i.test(probability)){
      const XLSX=require('../vendor/xlsx.full.min.js');const book=XLSX.read(await fsp.readFile(probability),{type:'buffer',raw:true});
      probabilityCSV=path.join(out,'converted_probabilities.csv');await fsp.writeFile(probabilityCSV,XLSX.utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]),'utf8');
    }
    return await new Promise((resolve,reject)=>{
      const child=spawn(python,[script,'--mesh',mesh,'--probabilities',probabilityCSV,'--out',out,'--min-faces',String(minFaces),'--min-area',String(minArea),'--normal-sigma',String(normalSigma)],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',OPENBLAS_NUM_THREADS:'1'}});
      readoutProcess=child;let output='',errors='';
      child.stdout.on('data',data=>{const text=data.toString();output+=text;win?.webContents.send('readout-progress',text.trim());});
      child.stderr.on('data',data=>{errors+=data.toString();});
      child.on('error',error=>{readoutProcess=null;reject(error);});
      child.on('close',async(code,signal)=>{
        readoutProcess=null;
        try{
          await fsp.writeFile(path.join(out,'run.log'),output+'\n'+errors);
          if(code!==0)throw Error(signal?'读出已取消。':(errors.trim().split('\n').pop()||'读出失败，请查看结果目录中的 run.log。'));
          const segmentation=JSON.parse(await fsp.readFile(path.join(out,'segmentation.json'),'utf8'));
          const report=JSON.parse(await fsp.readFile(path.join(out,'report.json'),'utf8'));
          resolve({segmentation,report,directory:out});
        }catch(error){reject(error);}
      });
    });
  });
  ipcMain.handle('choose-model',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择原始三角网格模型',defaultPath:settings.lastModel||directory,properties:['openFile'],filters:[{name:'三角网格模型',extensions:['obj','ply']}]});
    if(result.canceled)return null;
    const file=result.filePaths[0];if(!/\.(obj|ply)$/i.test(file))throw Error('请选择 OBJ 或 PLY 模型。');
    settings.lastModel=file;saveSettings();const prob=probabilityFor(file);
    return {mesh:expose(file),probability:prob?expose(prob):null};
  });
  ipcMain.handle('choose-probability',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择模型对应的边概率表',defaultPath:settings.lastModel?path.dirname(settings.lastModel):directory,properties:['openFile'],filters:[{name:'边概率表',extensions:['csv','xls','xlsx']}]});
    if(result.canceled)return null;
    if(!/\.(csv|xlsx|xls)$/i.test(result.filePaths[0]))throw Error('请选择 CSV、XLS 或 XLSX 概率表。');
    return expose(result.filePaths[0]);
  });
  ipcMain.handle('choose-directory',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择包含模型与同名概率表的文件夹',defaultPath:directory,properties:['openDirectory']});
    if(result.canceled)return null;
    const models=await listModels(result.filePaths[0]);directory=result.filePaths[0];settings.directory=directory;saveSettings();return {models,directory};
  });
  ipcMain.handle('save-image',async(event,dataURL,name)=>{
    trusted(event);
    if(typeof dataURL!=='string'||!dataURL.startsWith('data:image/png;base64,')||dataURL.length>80000000)throw Error('无效的 PNG 图像。');
    const safe=String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,160);
    const result=await dialog.showSaveDialog(owner(),{title:'保存模型视图',defaultPath:safe+'__probability.png',filters:[{name:'PNG 图像',extensions:['png']}]});
    if(result.canceled)return null;
    await fsp.writeFile(result.filePath,Buffer.from(dataURL.slice(22),'base64'));return path.basename(result.filePath);
  });
}
async function start(){
  const defaults=[settings.directory,path.resolve(portableRoot,'../manual_test/v3'),path.resolve(root,'../manual_test/v3')];
  directory=defaults.find(p=>p&&fs.existsSync(p));
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  protocol.handle('edgescope',async request=>{
    const url=new URL(request.url);if(url.hostname!=='app')return new Response('Not found',{status:404});
    if(url.pathname==='/api/models')return Response.json(await listModels(directory));
    if(url.pathname.startsWith('/data/')){
      const file=allowedFiles.get(url.pathname.slice(6));return file?net.fetch(pathToFileURL(file).href):new Response('Not found',{status:404});
    }
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)||!['.html','.css','.js','.mjs'].includes(path.extname(file))||pathname.includes('/desktop/'))return new Response('Not found',{status:404});
    try{return await net.fetch(pathToFileURL(file).href);}catch{return new Response('Not found',{status:404});}
  });
  win=new BrowserWindow({width:1440,height:960,minWidth:1024,minHeight:700,title:'EdgeScope · 边界概率查看器',backgroundColor:'#f3f5f8',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!=='edgescope://app/index.html')event.preventDefault();});
  win.webContents.on('render-process-gone',(_event,details)=>dialog.showErrorBox('查看器渲染进程退出','请重新打开软件。原因：'+details.reason));
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'文件',submenu:[{label:'选择模型…',accelerator:'CmdOrCtrl+O',click:()=>command('chooseModel')},{label:'选择概率表…',accelerator:'CmdOrCtrl+Shift+O',click:()=>command('chooseProbability')},{label:'加载已选文件',accelerator:'CmdOrCtrl+Enter',click:()=>command('loadDesktop')},{label:'选择模型文件夹…',click:()=>command('chooseDirectory')},{type:'separator'},{label:'保存图片…',accelerator:'CmdOrCtrl+Shift+S',click:()=>command('capture')},{type:'separator'},{label:'退出',role:'quit'}]},
    {label:'视图',submenu:[{label:'重置模型视角',accelerator:'CmdOrCtrl+0',click:()=>command('reset')},{label:'全屏',role:'togglefullscreen'}]},
    {label:'帮助',submenu:[{label:'使用说明',click:()=>dialog.showMessageBox(win,{type:'info',title:'EdgeScope 使用说明',message:'模型与边概率可视化',detail:'1. 选择 OBJ / PLY 模型，再选择 CSV / XLS / XLSX 概率表，点击加载。\n2. 同目录、同名的概率表会自动配对；也可手动更换。\n3. 左键拖动旋转，滚轮缩放，右键平移；点击边查看概率。\n4. 左侧可调整颜色、对比度和最低概率。\n\nOBJ 必须是预测使用的原始三角网格。PLY 支持原 v3 导出的二进制格式，并依赖一致的三角形顺序。\n概率表读取第一张工作表的 boundary_probability 列。\n所有处理均在本机进行。'})},{label:'关于 EdgeScope',click:()=>dialog.showMessageBox(win,{type:'info',title:'关于 EdgeScope',message:'EdgeScope 1.0.0',detail:'边界概率桌面查看器\nElectron '+process.versions.electron+' · Three.js · SheetJS\nWindows x64 免安装版'})}]}
  ]));
  win.once('ready-to-show',()=>win.show());
  await win.loadURL('edgescope://app/index.html');
}
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(start).catch(error=>{dialog.showErrorBox('EdgeScope 无法启动',error.stack||error.message);app.quit();});
  app.on('window-all-closed',()=>{readoutProcess?.kill();app.quit();});
}
