const {app,BrowserWindow,Menu,dialog,ipcMain,protocol,net,session,nativeTheme}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {ReadoutResults}=require('./readout-results.cjs');
const results=new ReadoutResults();let currentOperation=null,quitting=false,quitReady=false;
function exclusive(fn){
  if(currentOperation||quitting)throw Error('正在处理读出结果，请稍候。');
  const task=Promise.resolve().then(fn);currentOperation=task;
  return task.finally(()=>{if(currentOperation===task)currentOperation=null;});
}
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
async function probabilityFor(file){
  const {matchProbability}=await import('../model-pairs.mjs');
  const folder=path.dirname(file),entries=await fsp.readdir(folder,{withFileTypes:true});
  return path.join(folder,matchProbability(path.basename(file),entries.filter(e=>e.isFile()).map(e=>e.name)));
}
async function listModels(folder){
  if(!folder||!fs.existsSync(folder))return [];
  const entries=await fsp.readdir(folder,{withFileTypes:true});
  const folders=[folder,...entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>path.join(folder,e.name))],models=[];
  for(const current of folders){
    const files=await fsp.readdir(current,{withFileTypes:true}),used=new Set();
    const candidates=files.filter(e=>e.isFile()&&/\.(obj|ply)$/i.test(e.name)).map(e=>e.name).sort((a,b)=>Number(/\.ply$/i.test(a))-Number(/\.ply$/i.test(b))||a.localeCompare(b));
    for(const name of candidates){
      const file=path.join(current,name),base=stem(file);if(used.has(base))continue;
      let prob;try{prob=await probabilityFor(file);}catch{continue;}
      used.add(base);models.push({name:current===folder?base:path.basename(current)+' / '+base,mesh:expose(file).url,probability:expose(prob).url,meshName:name,probabilityName:path.basename(prob)});
    }
  }
  return models;
}
function saveSettings(){fs.writeFileSync(configPath,JSON.stringify(settings,null,2));}
function trusted(event){if(event.sender!==win?.webContents||event.senderFrame?.url!=='edgescope://app/index.html')throw Error('Unknown application sender');}
function command(name){win?.webContents.send('viewer-command',name);}
const owner=()=>win;
function registerIPC(){
  ipcMain.handle('set-theme',(event,value)=>{trusted(event);if(!['light','dark'].includes(value))throw Error('主题无效。');settings.theme=value;saveSettings();if(nativeTheme)nativeTheme.themeSource=value;win?.setBackgroundColor?.(value==='dark'?'#151c27':'#f3f5f8');});
  ipcMain.handle('choose-step',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'打开 STEP 模型',defaultPath:settings.lastStep||settings.stepDirectory||directory,properties:['openFile'],filters:[{name:'STEP 模型',extensions:['step','stp']}]});
    if(result.canceled)return null;
    const file=result.filePaths[0];if(!/\.(step|stp)$/i.test(file))throw Error('请选择 STEP 或 STP 文件。');
    settings.lastStep=file;saveSettings();return expose(file);
  });
  ipcMain.handle('choose-step-directory',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择 STEP 文件夹',defaultPath:settings.stepDirectory||directory,properties:['openDirectory']});
    if(result.canceled)return null;
    const folder=result.filePaths[0],entries=await fsp.readdir(folder,{withFileTypes:true});
    const files=entries.filter(e=>e.isFile()&&/\.(step|stp)$/i.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})).map(e=>expose(path.join(folder,e.name)));
    settings.stepDirectory=folder;saveSettings();return {directory:folder,files};
  });
  ipcMain.handle('choose-segmentation',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择读出结果 segmentation.json',properties:['openFile'],filters:[{name:'分片标签',extensions:['json']}]});
    if(result.canceled)return null;
    return JSON.parse(await fsp.readFile(result.filePaths[0],'utf8'));
  });
  ipcMain.handle('cancel-readout',event=>{trusted(event);if(readoutProcess)readoutProcess.kill();});
  ipcMain.handle('clear-readout',event=>{trusted(event);return exclusive(()=>results.clear());});
  ipcMain.handle('download-readout',event=>{
    trusted(event);return exclusive(async()=>{
      if(!results.current?.ready)throw Error('当前没有可下载的读出结果。');
      const choice=await dialog.showOpenDialog(owner(),{title:'下载读出结果到文件夹',defaultPath:settings.outputDirectory||results.current.parent,properties:['openDirectory','createDirectory']});
      if(choice.canceled)return null;
      const folder=await results.exportTo(choice.filePaths[0]);
      settings.outputDirectory=choice.filePaths[0];saveSettings();return {directory:folder};
    });
  });
  ipcMain.handle('save-merged-readout',(event,options)=>{
    trusted(event);return exclusive(async()=>{
      const resolve=value=>{const url=new URL(value);if(url.protocol!=='edgescope:'||url.hostname!=='app'||!url.pathname.startsWith('/data/'))throw Error('模型文件授权无效。');const file=allowedFiles.get(url.pathname.slice(6));if(!file)throw Error('请重新选择模型。');return file;};
      const mesh=resolve(options.mesh),probability=resolve(options.probability),record=await results.create(mesh);
      try{
        const {exportMerged}=await import('./merged-export.mjs');
        const result=await exportMerged(record.folder,mesh,probability,options.segmentation);
        for(const old of [...results.owned.values()])if(old!==record)await results.remove(old);
        record.ready=true;results.current=record;return result;
      }catch(error){await results.remove(record);throw error;}
    });
  });
  ipcMain.handle('run-readout',(event,options)=>{
    trusted(event);return exclusive(async()=>{
      const resolveURL=value=>{const u=new URL(value);if(u.protocol!=='edgescope:'||u.hostname!=='app'||!u.pathname.startsWith('/data/'))throw Error('请先选择模型。');const file=allowedFiles.get(u.pathname.slice(6));if(!file)throw Error('文件授权已失效，请重新选择。');return file;};
      const mesh=resolveURL(options.mesh),probability=resolveURL(options.probability);
      const minFaces=Number(options.minFaces),minArea=Number(options.minArea),normalSigma=Number(options.normalSigma);
      if(!Number.isInteger(minFaces)||minFaces<1||!Number.isFinite(minArea)||minArea<0||minArea>1||!Number.isFinite(normalSigma)||normalSigma<.05||normalSigma>1)throw Error('读出参数无效。');
      const python=path.join(process.resourcesPath,'python','python.exe'),script=path.join(process.resourcesPath,'readout','geometry_readout.py');
      if(!fs.existsSync(python)||!fs.existsSync(script))throw Error('未找到随软件打包的读出运行库，请运行新版完整软件。');
      // A rerun keeps the previous successful result until the replacement is ready.
      const record=await results.create(mesh),out=record.folder;
      try{
        let probabilityCSV=probability;
        if(!/\.csv$/i.test(probability)){
          const XLSX=require('../vendor/xlsx.full.min.js'),book=XLSX.read(await fsp.readFile(probability),{type:'buffer',raw:true});
          probabilityCSV=path.join(out,'converted_probabilities.csv');await fsp.writeFile(probabilityCSV,XLSX.utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]),'utf8');
        }
        if(quitting)throw Error('软件正在退出。');
        const result=await new Promise((resolve,reject)=>{
          const child=spawn(python,[script,'--mesh',mesh,'--probabilities',probabilityCSV,'--out',out,'--min-faces',String(minFaces),'--min-area',String(minArea),'--normal-sigma',String(normalSigma)],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',OPENBLAS_NUM_THREADS:'1'}});
          readoutProcess=child;let output='',errors='',spawnError=null;
          child.stdout.on('data',data=>{const text=data.toString();output+=text;if(!win?.isDestroyed())win?.webContents.send('readout-progress',text.trim());});
          child.stderr.on('data',data=>{errors+=data.toString();});
          child.on('error',error=>{spawnError=error;});
          child.on('close',async(code,signal)=>{
            readoutProcess=null;
            try{
              if(spawnError)throw spawnError;
              await fsp.writeFile(path.join(out,'run.log'),output+'\n'+errors);
              if(code!==0)throw Error(signal||child.killed?'读出已取消。':(errors.trim().split('\n').pop()||'读出失败。'));
              const segmentation=JSON.parse(await fsp.readFile(path.join(out,'segmentation.json'),'utf8'));
              const report=JSON.parse(await fsp.readFile(path.join(out,'report.json'),'utf8'));
              resolve({segmentation,report,directory:out});
            }catch(error){reject(error);}
          });
        });
        for(const old of [...results.owned.values()])if(old!==record)await results.remove(old);
        record.ready=true;results.current=record;return result;
      }catch(error){
        try{await results.remove(record);}catch(cleanup){throw Error(error.message+' 临时结果清理失败：'+cleanup.message);}
        throw error;
      }
    });
  });
  ipcMain.handle('choose-model',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择模型（自动加载同目录概率表）',defaultPath:settings.lastModel||directory,properties:['openFile'],filters:[{name:'三角网格模型',extensions:['obj','ply']}]});
    if(result.canceled)return null;
    const file=result.filePaths[0];if(!/\.(obj|ply)$/i.test(file))throw Error('请选择 OBJ 或 PLY 模型。');
    const prob=await probabilityFor(file);settings.lastModel=file;saveSettings();
    return {mesh:expose(file),probability:prob?expose(prob):null};
  });
  ipcMain.handle('choose-directory',async event=>{
    trusted(event);const result=await dialog.showOpenDialog(owner(),{title:'选择模型文件夹（支持下一级模型子文件夹）',defaultPath:directory,properties:['openDirectory']});
    if(result.canceled)return null;
    const models=await listModels(result.filePaths[0]);directory=result.filePaths[0];settings.directory=directory;saveSettings();return {models,directory};
  });
  ipcMain.handle('save-image',async(event,dataURL,name,view)=>{
    trusted(event);
    if(typeof dataURL!=='string'||!dataURL.startsWith('data:image/png;base64,')||dataURL.length>80000000)throw Error('无效的 PNG 图像。');
    const safe=String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,160);
    const result=await dialog.showSaveDialog(owner(),{title:'保存模型视图',defaultPath:safe+(view==='step'?'__step.png':'__probability.png'),filters:[{name:'PNG 图像',extensions:['png']}]});
    if(result.canceled)return null;
    await fsp.writeFile(result.filePath,Buffer.from(dataURL.slice(22),'base64'));return path.basename(result.filePath);
  });
}
async function start(){
  if(nativeTheme)nativeTheme.themeSource=settings.theme==='dark'?'dark':'light';
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
    if(!file.startsWith(root+path.sep)||!['.html','.css','.js','.mjs','.wasm'].includes(path.extname(file))||pathname.includes('/desktop/'))return new Response('Not found',{status:404});
    try{return await net.fetch(pathToFileURL(file).href);}catch{return new Response('Not found',{status:404});}
  });
  win=new BrowserWindow({width:1680,height:960,minWidth:1200,minHeight:700,title:'EdgeScope · 边界概率查看器',backgroundColor:'#f3f5f8',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!=='edgescope://app/index.html')event.preventDefault();});
  win.webContents.on('render-process-gone',(_event,details)=>dialog.showErrorBox('查看器渲染进程退出','请重新打开软件。原因：'+details.reason));
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'文件',submenu:[{label:'打开 STEP 文件…',click:()=>command('chooseStep')},{label:'选择 STEP 文件夹…',click:()=>command('chooseStepDirectory')},{type:'separator'},{label:'打开模型与概率…',accelerator:'CmdOrCtrl+O',click:()=>command('chooseModel')},{label:'下载读出结果…',click:()=>command('downloadReadout')},{label:'删除临时结果',click:()=>command('deleteReadout')},{label:'选择模型文件夹…',click:()=>command('chooseDirectory')},{type:'separator'},{label:'保存 STEP 图片…',click:()=>command('stepCapture')},{label:'保存概率/分片图片…',accelerator:'CmdOrCtrl+Shift+S',click:()=>command('capture')},{type:'separator'},{label:'退出',role:'quit'}]},
    {label:'视图',submenu:[{label:'重置 STEP 视角',click:()=>command('stepReset')},{label:'重置概率/分片视角',accelerator:'CmdOrCtrl+0',click:()=>command('reset')},{label:'全屏',role:'togglefullscreen'}]},
    {label:'帮助',submenu:[{label:'使用说明',click:()=>dialog.showMessageBox(win,{type:'info',title:'EdgeScope 使用说明',message:'模型与边概率可视化',detail:'1. 选择 OBJ / PLY 模型，自动匹配同目录概率表并加载。\n2. 读出自动生成临时结果；点击下载结果可选择永久保存位置。切换右侧模型或正常退出会清理临时结果。左侧 STEP 独立保留。\n3. 左键拖动旋转，滚轮缩放，右键平移；点击边查看概率。\n4. 左侧操作 STEP；右侧调整概率、对比度和分片读出。\n\nOBJ 必须是预测使用的原始三角网格。PLY 支持原 v3 导出的二进制格式，并依赖一致的三角形顺序。\n概率表读取第一张工作表的 boundary_probability 列。\n所有处理均在本机进行。'})},{label:'关于 EdgeScope',click:()=>dialog.showMessageBox(win,{type:'info',title:'关于 EdgeScope',message:'EdgeScope 1.0.0',detail:'边界概率桌面查看器\nElectron '+process.versions.electron+' · Three.js · SheetJS\nWindows x64 免安装版'})}]}
  ]));
  win.once('ready-to-show',()=>win.show());
  await win.loadURL('edgescope://app/index.html');
}
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(start).catch(error=>{dialog.showErrorBox('EdgeScope 无法启动',error.stack||error.message);app.quit();});
  app.on('before-quit',event=>{
    if(quitReady)return;event.preventDefault();if(quitting)return;quitting=true;
    readoutProcess?.kill();
    (async()=>{
      try{await currentOperation;}catch{}
      try{await results.clear();}catch(error){dialog.showErrorBox('临时结果清理失败',error.message+'\n目录：'+[...results.owned.keys()].join('\n'));}
      quitReady=true;app.quit();
    })();
  });
  app.on('window-all-closed',()=>app.quit());
}
