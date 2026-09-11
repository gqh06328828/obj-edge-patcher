"""Audit saved results; STEP metadata is read here only AFTER inference."""
import csv
import json
from pathlib import Path
import numpy as np
from geometry_readout import load_mesh

root=Path(__file__).resolve().parent
reference=root.parent/'manual_test'/'新建文件夹'
lines=['# v1 样本运行与输出验收','','所有样本采用同一组默认参数，未按 STEP 面数调参。下表的 STEP face_count 仅在推理结束后从已有分类 JSON 读取作参考，不是面匹配评价。','',
       '| 模型 | 三角形数 | 读出片数 | STEP 参考面数 | 最小片三角形 | 最小面积占比 | 低概率切边 (<0.3) | 强制合并 |',
       '|---|---:|---:|---:|---:|---:|---:|---:|']
for result in sorted((root/'results').glob('*_v1')):
    report=json.loads((result/'report.json').read_text(encoding='utf-8'))
    metadata=json.loads((result/'segmentation.json').read_text(encoding='utf-8'))
    with (result/'face_labels.csv').open() as f:rows=list(csv.DictReader(f))
    labels=np.array(metadata['labels'])
    assert len(rows)==report['triangle_count']==len(labels)
    assert [int(r['triangle_id']) for r in rows]==list(range(1,len(rows)+1))
    assert np.array_equal(labels,[int(r['patch_id']) for r in rows])
    v,f=load_mesh(result/'patches.ply')
    source_v,source_f=load_mesh(report['input']['model'])
    assert len(f)==len(source_f)
    assert np.array_equal(v[f],source_v[source_f].astype(np.float32)), 'PLY geometry/order changed beyond documented float32 conversion'
    assert report['final_energy']['total']<=report['energy_after_minimum']['total']+1e-7
    assert report['all_faces_assigned'] and report['all_patches_connected'] and report['minimum_support_satisfied']
    name=result.name.removesuffix('_v1')
    source=reference/name/(name+'_classified_colored_faces.json')
    count=json.loads(source.read_text(encoding='utf-8'))['face_count'] if source.exists() else '未提供'
    lines.append(f'| {name} | {len(labels):,} | {report["patch_count"]} | {count} | {report["minimum_patch_faces"]} | {report["minimum_patch_area_fraction"]:.4%} | {report["low_probability_cut_edges"]} | {report["forced_merges"]} |')
    print('PASS export:',name)
lines+=['','验收内容：标签 CSV 与 JSON 一致、原面编号完整、彩色 PLY 面顺序一致且仅做声明的 float32 坐标转换、局部细化未增加联合目标，以及运行时连通/最小尺度检查。',
        '', '9 项合成测试通过：低概率折痕、平面噪声、圆柱、小闭环、平移/尺度、缺失概率、不可满足的最小规模、重开误合并、平面上的完整高概率边界。',
        '', '**尚未完成**：真实 STEP 面的一一对应、边界 precision/recall、几何偏差、倒角召回。片数相同不证明正确；片数不同也不能单独定位是哪条边错了。',
        '', 'XAA7000200_part_95 和 XAV2101024_part_1 的读出片数少于 STEP 面数，应重点检查相切面、过渡面和小面是否被合并。',
        '', '每个结果目录包含 patches.ply、按片分组的 patches.obj、face_labels.csv、boundary_edges.csv、segmentation.json 和完整 report.json。']
(root/'RESULTS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
