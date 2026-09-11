export const modelStem=name=>name.replace(/__epoch\d+__segmented\.ply$/i,'').replace(/\.(obj|ply)$/i,'');

export function matchProbability(meshName,names){
  const tables=names.filter(n=>/\.(csv|xlsx|xls)$/i.test(n));
  const base=modelStem(meshName).toLowerCase();
  for(const stem of [base+'__edge_boundary_probability',base]){
    const matches=tables.filter(n=>n.replace(/\.(csv|xlsx|xls)$/i,'').toLowerCase()===stem);
    if(matches.length===1)return matches[0];
    if(matches.length>1)throw Error(`${meshName} 有多个同名概率表，请在模型目录中只保留要使用的一个。`);
  }
  const models=new Set(names.filter(n=>/\.(obj|ply)$/i.test(n)).map(n=>modelStem(n).toLowerCase()));
  if(models.size===1){
    const generic=tables.filter(n=>/^edge_boundary_probability\.(csv|xlsx|xls)$/i.test(n));
    if(generic.length===1)return generic[0];
    if(generic.length>1)throw Error('模型目录中有多个 edge_boundary_probability 概率表，请只保留一个。');
    if(tables.length===1)return tables[0];
  }
  throw Error(`${meshName} 未找到唯一对应的概率表。请将模型和概率表放在同一文件夹；多模型目录请使用同名概率表。`);
}
