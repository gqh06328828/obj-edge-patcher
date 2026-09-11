const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

// Only directories created by this instance can be deleted. User exports are never registered.
class ReadoutResults{
  constructor(){this.owned=new Map();this.current=null;}
  async create(mesh){
    const parent=await fs.realpath(path.dirname(mesh));
    const folder=await fs.mkdtemp(path.join(parent,'.edgescope-readout-'));
    const record={folder,parent,token:randomUUID(),name:path.basename(mesh).replace(/\.(obj|ply)$/i,''),ready:false};
    await fs.writeFile(path.join(folder,'.edgescope-owned.json'),JSON.stringify({token:record.token}));
    this.owned.set(folder,record);return record;
  }
  async validate(record){
    const folder=path.resolve(record.folder);
    if(this.owned.get(folder)!==record||path.dirname(folder)!==record.parent||!path.basename(folder).startsWith('.edgescope-readout-'))throw Error('临时结果目录校验失败，已停止清理。');
    const stat=await fs.lstat(folder);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(folder)!==folder)throw Error('临时结果目录位置已改变，已停止清理。');
    const marker=JSON.parse(await fs.readFile(path.join(folder,'.edgescope-owned.json'),'utf8'));
    if(marker.token!==record.token)throw Error('临时结果标记不匹配，已停止清理。');
    await this.validateTree(folder);
  }
  async validateTree(folder){
    for(const item of await fs.readdir(folder,{withFileTypes:true})){
      const file=path.join(folder,item.name),stat=await fs.lstat(file);
      if(stat.isSymbolicLink())throw Error('临时结果中出现链接，已停止操作。');
      if(stat.isDirectory())await this.validateTree(file);
    }
  }
  async remove(record){
    try{await this.validate(record);}catch(error){
      // An already removed root is harmless; a missing marker is not.
      if(error.code==='ENOENT'&&!(await fs.lstat(record.folder).catch(()=>null))){this.owned.delete(record.folder);if(this.current===record)this.current=null;return;}
      throw error;
    }
    await fs.rm(record.folder,{recursive:true,force:false});
    this.owned.delete(record.folder);if(this.current===record)this.current=null;
  }
  async clear(){
    for(const record of [...this.owned.values()])await this.remove(record);
  }
  async exportTo(destination){
    const record=this.current;
    if(!record?.ready)throw Error('当前没有可下载的读出结果。');
    await this.validate(record);
    const parent=await fs.realpath(destination);
    for(const owned of this.owned.values()){
      const relative=path.relative(owned.folder,parent);
      if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('请选择临时结果文件夹以外的下载位置。');
    }
    const safe=record.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80);
    const folder=await fs.mkdtemp(path.join(parent,safe+'_readout_'));
    try{
      for(const name of await fs.readdir(record.folder)){
        if(name==='.edgescope-owned.json')continue;
        await fs.cp(path.join(record.folder,name),path.join(folder,name),{recursive:true,errorOnExist:true,force:false});
      }
    }catch(error){throw Error(`下载未完成：${error.message}。部分文件位于 ${folder}，临时结果仍保留，可重试。`);}
    return folder;
  }
}
module.exports={ReadoutResults};
