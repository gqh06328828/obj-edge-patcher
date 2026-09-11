"""Geometry + uncertain boundary evidence readout. Requires only NumPy.

No STEP, original segmentation colors, or ground-truth labels enter inference.
All face ids preserve input triangle order. See DESIGN.md for limitations.
"""
from __future__ import annotations
import argparse
import colorsys
import csv
from dataclasses import asdict, dataclass
import hashlib
import heapq
import json
from pathlib import Path
import time
import numpy as np
from surface_evidence import SurfaceEvidence
from freeform_evidence import FreeformEvidence


@dataclass
class Config:
    normal_sigma: float = 0.20
    distance_edges: float = 0.35
    boundary_weight: float = 0.002
    probability_clip: float = 2.2
    region_penalty: float = 0.0008
    seed_faces: int = 64
    min_faces: int = 80
    min_area_fraction: float = 0.0004
    split_passes: int = 2
    refine_passes: int = 2
    continuation_distance: float = 0.60
    continuation_normal: float = 0.40
    continuation_curvature: float = 0.25
    continuation_min_faces: int = 48
    surface_samples: int = 192
    freeform_probability: float = 0.15
    freeform_curvature: float = 0.50
    freeform_outlier_fraction: float = 0.08
    freeform_ridge_contrast: float = 0.15


class DSU:
    def __init__(self, n):
        self.parent = np.arange(n)
        self.size = np.ones(n, dtype=np.int64)

    def find(self, i):
        i = int(i)
        while i != self.parent[i]:
            self.parent[i] = self.parent[self.parent[i]]
            i = int(self.parent[i])
        return i

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a == b:
            return a
        if self.size[a] < self.size[b]:
            a, b = b, a
        self.parent[b] = a
        self.size[a] += self.size[b]
        return a

    def labels(self):
        return np.unique([self.find(i) for i in range(len(self.parent))], return_inverse=True)[1]


def load_mesh(filename):
    filename = Path(filename)
    if filename.suffix.lower() == '.obj':
        vertices, faces = [], []
        with filename.open(encoding='utf-8-sig') as stream:
            for line in stream:
                p = line.split('#')[0].split()
                if not p:
                    continue
                if p[0] == 'v':
                    vertices.append(list(map(float, p[1:4])))
                elif p[0] == 'f':
                    if len(p) != 4:
                        raise ValueError('Input must be triangulated; automatic triangulation changes face ids.')
                    f = [int(x.split('/')[0]) for x in p[1:]]
                    faces.append([i-1 if i > 0 else len(vertices)+i for i in f])
        v, f = np.asarray(vertices, dtype=float), np.asarray(faces, dtype=np.int64)
    elif filename.suffix.lower() == '.ply':
        with filename.open('rb') as stream:
            header = []
            while True:
                line = stream.readline()
                if not line or len(header) > 100:
                    raise ValueError('Invalid PLY header')
                header.append(line.decode('ascii').strip())
                if header[-1] == 'end_header':
                    break
            if 'format binary_little_endian 1.0' not in header:
                raise ValueError('PLY reader supports v3 binary little-endian files.')
            nv = int(next(s for s in header if s.startswith('element vertex ')).split()[-1])
            nf = int(next(s for s in header if s.startswith('element face ')).split()[-1])
            begin = next(i for i,s in enumerate(header) if s.startswith('element vertex '))
            end = next(i for i,s in enumerate(header) if s.startswith('element face '))
            types = {'float':'<f4','float32':'<f4','double':'<f8','uchar':'u1','uint8':'u1'}
            dtype = np.dtype([(s.split()[2], types[s.split()[1]]) for s in header[begin+1:end] if s.startswith('property ')])
            values = np.fromfile(stream, dtype=dtype, count=nv)
            v = np.column_stack([values[k] for k in ('x','y','z')]).astype(float)
            if 'property list uchar int vertex_indices' not in header:
                raise ValueError('Unsupported PLY face format')
            records = np.fromfile(stream, dtype=np.dtype([('n','u1'),('v','<i4',(3,))]), count=nf)
            if len(records) != nf or np.any(records['n'] != 3):
                raise ValueError('PLY must contain triangles')
            f = records['v'].astype(np.int64)
    else:
        raise ValueError('Supported model formats: OBJ and v3 PLY')
    if v.ndim != 2 or v.shape[1] != 3 or not np.isfinite(v).all() or f.ndim != 2 or f.shape[1] != 3 or not len(f):
        raise ValueError('Invalid or empty mesh')
    if f.min() < 0 or f.max() >= len(v):
        raise ValueError('Vertex index out of range')
    return v, f


def read_predictions(filename):
    with Path(filename).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        required = {'edge_id','vertex_1','vertex_2','boundary_probability','incident_triangle_ids'}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError('CSV missing columns: '+str(required-set(reader.fieldnames or [])))
        rows = list(reader)
    ids, endpoints, triangles, probabilities = [], [], [], []
    for row in rows:
        ids.append(int(row['edge_id']))
        endpoints.append([int(row['vertex_1'])-1, int(row['vertex_2'])-1])
        incident = [int(s)-1 for s in row['incident_triangle_ids'].split(';') if s.strip()]
        if len(incident) not in (1,2):
            raise ValueError('Nonmanifold or invalid incident triangles at edge '+row['edge_id'])
        triangles.append(incident if len(incident)==2 else incident+[-1])
        value = row['boundary_probability'].strip()
        p = float(value) if value else np.nan
        if np.isinf(p) or (np.isfinite(p) and not 0 <= p <= 1):
            raise ValueError('Probability outside [0,1]')
        probabilities.append(p)
    ids = np.asarray(ids)
    if len(np.unique(ids)) != len(ids) or not len(ids) or ids.min()<1:
        raise ValueError('Duplicate/invalid edge ids')
    return ids, np.asarray(endpoints), np.asarray(triangles), np.asarray(probabilities)


def validate_mapping(vertices, faces, predictions, is_obj):
    ids, endpoints, incident, probabilities = predictions
    if incident.min() < -1 or incident.max() >= len(faces) or np.any(incident[:,0]<0):
        raise ValueError('Triangle id outside model')
    # Exact coordinate welding is used only for de-indexed PLY topology validation.
    if is_obj:
        canonical = faces
        cv = vertices
    else:
        cv, inverse = np.unique(vertices, axis=0, return_inverse=True)
        canonical = inverse[faces]
    topology = {};directions = {}
    for i,(a,b,c) in enumerate(canonical):
        for x,y in ((a,b),(b,c),(c,a)):
            key = (min(x,y),max(x,y))
            topology.setdefault(key, []).append(i)
            directions.setdefault(key, []).append(1 if x<y else -1)
    if any(len(owners)>2 for owners in topology.values()):
        raise ValueError('Nonmanifold geometry: readout requires at most two faces per edge')
    if any(len(signs)==2 and signs[0]==signs[1] for signs in directions.values()):
        raise ValueError('Inconsistent face winding: orient the original mesh consistently without changing face order before readout')
    seen = set()
    positions = np.empty((len(ids),2,3),dtype=float)
    for k,(u,v) in enumerate(incident):
        if is_obj:
            a,b = endpoints[k]
            key = (min(a,b),max(a,b))
        else:
            if v < 0:
                raise ValueError('Open-boundary PLY requires original OBJ to recover endpoint mapping')
            common = set(canonical[u]).intersection(canonical[v])
            if len(common) != 2:
                raise ValueError('No unique shared edge at CSV edge '+str(ids[k]))
            key = tuple(sorted(common))
        if key not in topology or sorted(topology[key]) != sorted([int(x) for x in (u,v) if x>=0]) or key in seen:
            raise ValueError('CSV/model topology mismatch or duplicate at edge '+str(ids[k]))
        seen.add(key)
        positions[k] = cv[list(key)]
    if len(seen) != len(topology):
        raise ValueError('CSV does not cover all mesh edges; refusing to invent predictions')
    return positions


class Readout:
    def __init__(self, vertices, faces, incident, probabilities, edge_positions, config=None):
        self.cfg = config or Config()
        c = self.cfg
        if min(c.normal_sigma,c.distance_edges,c.region_penalty,c.probability_clip,c.min_faces,c.seed_faces)<=0 or not 0<=c.min_area_fraction<=1 or c.boundary_weight<0:
            raise ValueError('Invalid configuration')
        if (not all(np.isfinite(value) for value in asdict(c).values()) or
            min(c.continuation_distance,c.continuation_normal,c.continuation_curvature)<=0 or
            c.continuation_min_faces<12 or c.surface_samples<24):
            raise ValueError('Invalid surface-continuation configuration')
        if not 0<c.freeform_probability<.5 or not 0<c.freeform_curvature<=1 or not 0<=c.freeform_outlier_fraction<.1 or not 0<c.freeform_ridge_contrast<.5:
            raise ValueError('Invalid freeform-continuation configuration')
        self.vertices, self.faces = vertices, faces
        self.n = len(faces)
        tri = vertices[faces]
        cross = np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0])
        norms = np.linalg.norm(cross,axis=1)
        if np.any(norms<=0):
            raise ValueError('Degenerate triangles must be repaired before inference; face ids cannot be silently removed')
        self.raw_normals = cross/norms[:,None]
        self.area = norms/norms.sum()
        scale = np.linalg.norm(np.ptp(vertices,axis=0))
        self.center = (vertices.min(axis=0)+vertices.max(axis=0))/2
        self.scale = float(scale)
        self.x = (tri.mean(axis=1)-self.center)/scale
        self.length = np.linalg.norm(edge_positions[:,1]-edge_positions[:,0],axis=1)/scale
        self.incident, self.probabilities = incident, probabilities
        valid = incident[:,1]>=0
        self.internal_ids = np.flatnonzero(valid)
        self.uv = incident[valid]
        self.adj = [[] for _ in range(self.n)]
        for e,(u,v) in zip(self.internal_ids,self.uv):
            self.adj[u].append((int(v),int(e)))
            self.adj[v].append((int(u),int(e)))
        # Winding has been validated by validate_mapping; never flip normals independently.
        normals = self.raw_normals.copy()
        accumulated = normals*self.area[:,None]
        weights = self.area.copy()
        for _ in range(2):
            accumulated = normals*self.area[:,None]
            weights = self.area.copy()
            u,v = self.uv.T
            smooth = np.einsum('ij,ij->i',self.raw_normals[u],self.raw_normals[v])>np.cos(np.deg2rad(25))
            a,b = u[smooth],v[smooth]
            np.add.at(accumulated,a,normals[b]*self.area[b,None]);np.add.at(accumulated,b,normals[a]*self.area[a,None])
            np.add.at(weights,a,self.area[b]);np.add.at(weights,b,self.area[a])
            normals = accumulated/np.maximum(np.linalg.norm(accumulated,axis=1)[:,None],1e-20)
        self.normals = normals
        self.sigma_d = c.distance_edges*float(np.median(self.length[self.length>0]))
        self.B = self.features(self.x)
        self.B[:,0,:] /= self.sigma_d
        self.B[:,1:,:] /= c.normal_sigma
        self.target = np.column_stack([np.zeros(self.n),normals/c.normal_sigma])
        p = np.where(np.isfinite(probabilities),probabilities,0.5)
        logits = np.clip(np.log(np.clip(1-p,1e-7,1)/np.clip(p,1e-7,1)), -c.probability_clip,c.probability_clip)
        area_geometry = norms.sum()/2/scale**2
        self.cost = c.boundary_weight*self.length/np.sqrt(area_geometry)*logits
        self.evidence = SurfaceEvidence(self)
        self.freeform = FreeformEvidence(self)
        self._certified_groups={}
        self._freeform_groups={}
        self.report = {'config':asdict(c),'method':'surface-continuation-readout-v2.1','step_used_for_inference':False,
                       'triangle_count':self.n,'missing_predictions':int(np.isnan(probabilities).sum()),'forced_merges':0,'accepted_splits':0,'refinement_moves':0,
                       'surface_merges':{},'surface_merge_events':[],'surface_split_vetoes':0,
                       'energy_interpretation':'Diagnostic quadric proxy; certified geometry merges may increase this value.'}
        self.report['implementation_sha256']={name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                              for name in ('geometry_readout.py','surface_evidence.py','freeform_evidence.py')}

    @staticmethod
    def features(x):
        a,b,c = x.T
        z=np.zeros(len(x));o=np.ones(len(x))
        return np.stack([np.column_stack([a*a,b*b,c*c,a*b,a*c,b*c,a,b,c,o]),
                         np.column_stack([2*a,z,z,b,c,z,o,z,z,z]),
                         np.column_stack([z,2*b,z,a,z,c,z,o,z,z]),
                         np.column_stack([z,z,2*c,z,a,b,z,z,o,z])],axis=1)

    def aggregate(self, labels):
        nr=int(labels.max())+1
        matrix=np.zeros((nr,10,10));rhs=np.zeros((nr,10))
        for a in range(10):
            rhs[:,a]=np.bincount(labels,weights=self.area*np.einsum('ij,ij->i',self.B[:,:,a],self.target),minlength=nr)
            for b in range(a,10):
                matrix[:,a,b]=np.bincount(labels,weights=self.area*np.einsum('ij,ij->i',self.B[:,:,a],self.B[:,:,b]),minlength=nr)
                matrix[:,b,a]=matrix[:,a,b]
        area=np.bincount(labels,weights=self.area,minlength=nr)
        count=np.bincount(labels,minlength=nr)
        return matrix,rhs,area,count

    def fit(self, matrix, rhs, area):
        ridge = max(float(np.trace(matrix))*1e-12,1e-15)
        coeff=np.linalg.solve(matrix+np.eye(10)*ridge,rhs)
        energy=max(0.,float(area/self.cfg.normal_sigma**2-2*rhs@coeff+coeff@matrix@coeff))
        return energy,coeff

    def initial_regions(self):
        dsu=DSU(self.n)
        u,v=self.uv.T
        angle=1-np.einsum('ij,ij->i',self.normals[u],self.normals[v])
        p=np.nan_to_num(self.probabilities[self.internal_ids],nan=.5)
        ordering=np.argsort(p+2*angle,kind='stable')
        for k in ordering:
            a,b=dsu.find(u[k]),dsu.find(v[k])
            if a!=b and dsu.size[a]+dsu.size[b]<=self.cfg.seed_faces and p[k]<.8 and angle[k]<.15:
                dsu.union(a,b)
        return dsu.labels()

    def coarsen(self, labels, enforce_minimum=False, certificates_only=False):
        labels=np.unique(labels,return_inverse=True)[1]
        matrix,rhs,area,count=self.aggregate(labels)
        nr=len(area);parent=np.arange(nr);active=np.ones(nr,dtype=bool);version=np.zeros(nr,dtype=int)
        order=np.argsort(labels,kind='stable')
        members=list(np.split(order,np.cumsum(count)[:-1]))
        certificates={}
        protected=np.zeros(nr,dtype=bool)
        freeform=np.zeros(nr,dtype=bool)
        for i,group in enumerate(members):
            previous=self._certified_groups.get(int(group[0]))
            protected[i]=previous is not None and np.array_equal(previous,group)
            previous=self._freeform_groups.get(int(group[0]))
            freeform[i]=previous is not None and np.array_equal(previous,group)
        certificate_phase=certificates_only
        energy=np.array([self.fit(matrix[i],rhs[i],area[i])[0] for i in range(nr)])
        adj=[{} for _ in range(nr)]
        interfaces=[{} for _ in range(nr)]
        for e,(u,v) in zip(self.internal_ids,self.uv):
            a,b=int(labels[u]),int(labels[v])
            if a!=b:
                adj[a][b]=adj[a].get(b,0.)+self.cost[e]
                adj[b][a]=adj[b].get(a,0.)+self.cost[e]
                interfaces[a].setdefault(b,[]).append(int(e))
                interfaces[b].setdefault(a,[]).append(int(e))
        heap=[]
        def delta(a,b,allow_certificate=True):
            merged=self.fit(matrix[a]+matrix[b],rhs[a]+rhs[b],area[a]+area[b])[0]
            change=merged-energy[a]-energy[b]-self.cfg.region_penalty-adj[a][b]
            network_barrier=adj[a][b]<-1e-12
            needs_certificate=certificates_only or change>=-1e-10 or protected[a] or protected[b]
            if (certificate_phase or protected[a] or protected[b]) and needs_certificate and allow_certificate:
                key=(min(a,b),max(a,b),int(version[min(a,b)]),int(version[max(a,b)]))
                if key not in certificates:
                    certificates[key]=self.evidence.certify(members[a],members[b])
                    if certificates[key] is None:
                        certificates[key]=self.freeform.certify(interfaces[a][b])
                model=certificates[key]
                if model is not None:
                    # Geometry is a decision criterion, not an unbounded
                    # numerical reward. This also avoids a high-p ring veto.
                    # Assemble probability-supported interiors before trying
                    # to override a predicted boundary using a local model.
                    # Otherwise two tiny graph patches can erase a good seam
                    # before the full freeform surface becomes observable.
                    priority=-self.cfg.region_penalty*(1 if network_barrier else 2)
                    return priority,merged,model.kind
                if certificates_only or protected[a] or protected[b]:
                    return float('inf'),merged,None
            return change,merged,None
        def push(a,b):
            if a>b:a,b=b,a
            change,merged,kind=delta(a,b)
            heapq.heappush(heap,(change,a,b,int(version[a]),int(version[b]),merged,kind))
        def merge(a,b,merged,kind=None):
            if len(adj[a])<len(adj[b]):a,b=b,a
            if kind is not None:
                self.report['surface_merge_events'].append({'model':kind,'left_anchor_triangle':int(members[a][0])+1,
                    'right_anchor_triangle':int(members[b][0])+1,'left_faces':int(count[a]),'right_faces':int(count[b]),
                    'interface_probability_cost':float(adj[a][b]),'proxy_geometry_increase':float(merged-energy[a]-energy[b])})
            matrix[a]+=matrix[b];rhs[a]+=rhs[b];area[a]+=area[b];count[a]+=count[b];energy[a]=merged
            members[a]=np.sort(np.concatenate([members[a],members[b]]));members[b]=np.empty(0,dtype=int)
            protected[a]=kind is not None
            freeform[a]=kind=='freeform'
            if kind is not None:
                counts=self.report['surface_merges'];counts[kind]=counts.get(kind,0)+1
            active[b]=False;parent[b]=a;version[a]+=1;version[b]+=1
            adj[a].pop(b,None)
            interfaces[a].pop(b,None)
            for neighbor,cost in list(adj[b].items()):
                adj[neighbor].pop(b,None)
                interfaces[neighbor].pop(b,None)
                if neighbor!=a:
                    adj[a][neighbor]=adj[a].get(neighbor,0.)+cost
                    adj[neighbor][a]=adj[a][neighbor]
                    combined=interfaces[a].get(neighbor,[])+interfaces[b][neighbor]
                    interfaces[a][neighbor]=combined;interfaces[neighbor][a]=combined
            adj[b].clear()
            interfaces[b].clear()
            return a
        for a in range(nr):
            for b in adj[a]:
                if a<b:push(a,b)
        while True:
            while heap:
                change,a,b,va,vb,merged,kind=heapq.heappop(heap)
                if not active[a] or not active[b] or va!=version[a] or vb!=version[b]:continue
                if change>=-1e-10:break
                root=merge(a,b,merged,kind)
                for neighbor in adj[root]:push(root,neighbor)
            if certificate_phase:break
            # Expensive continuation checks need supported regions. Assemble
            # micro-regions cheaply first, then use the same RAG/merge updater.
            certificate_phase=True;heap.clear()
            for a in np.flatnonzero(active):
                for b in adj[a]:
                    if a<b:push(int(a),b)
        if enforce_minimum:
            while True:
                small=np.flatnonzero(active & ((count<self.cfg.min_faces)|(area<self.cfg.min_area_fraction)))
                if not len(small):break
                a=int(small[np.argmin(area[small])])
                if not adj[a]:
                    raise ValueError(f'Input disconnected component has only {count[a]} faces / area fraction {area[a]:.8g}; cannot satisfy minimum without joining disconnected geometry. Lower the explicit minimum or process separately.')
                candidates=[]
                for b in adj[a]:
                    local=self.freeform.certify(interfaces[a][b])
                    # Minimum cleanup must not prefer a poor global fit over
                    # a good predicted seam. A local continuation can support
                    # attachment even when the small side cannot fit a model.
                    tier=0 if local is not None else (2 if adj[a][b]<0 else 1)
                    candidates.append((tier,delta(a,b,False)[0],int(b)))
                tier,change,b=min(candidates)
                _,merged,_=delta(a,b,False)
                merge(a,b,merged,'freeform' if tier==0 else None);self.report['forced_merges']+=1
        for i in range(nr):
            r=i
            while parent[r]!=r:r=parent[r]
            parent[i]=r
        self._certified_groups={int(members[i][0]):members[i].copy() for i in np.flatnonzero(active & protected)}
        self._freeform_groups={int(members[i][0]):members[i].copy() for i in np.flatnonzero(active & freeform)}
        return np.unique(parent[labels],return_inverse=True)[1]

    def split(self, labels):
        matrix,rhs,area,count=self.aggregate(labels)
        next_label=int(labels.max())+1;accepted=0
        for region in range(len(area)):
            if count[region]<2*self.cfg.min_faces or area[region]<2*self.cfg.min_area_fraction:continue
            old,coeff=self.fit(matrix[region],rhs[region],area[region])
            if old<2*self.cfg.region_penalty:continue
            members=np.flatnonzero(labels==region)
            # Geometry seeds; network controls frontier travel, never irrevocably blocks it.
            features=np.column_stack([self.normals[members],self.x[members]*.3])
            seed0=int(np.argmax(np.sum((features-features.mean(axis=0))**2,axis=1)))
            seed1=int(np.argmax(np.sum((features-features[seed0])**2,axis=1)))
            seeds=[int(members[seed0]),int(members[seed1])]
            if seeds[0]==seeds[1]:continue
            result={seeds[0]:0,seeds[1]:1};queue=[]
            def expand(u,label,distance):
                for v,e in self.adj[u]:
                    if labels[v]!=region or v in result:continue
                    p=self.probabilities[e] if np.isfinite(self.probabilities[e]) else .5
                    discrepancy=float(np.sum((self.normals[v]-self.normals[seeds[label]])**2))
                    travel=self.length[e]*(1+2*p+3*discrepancy)
                    heapq.heappush(queue,(distance+travel,int(v),label))
            expand(seeds[0],0,0);expand(seeds[1],1,0)
            while queue:
                distance,u,label=heapq.heappop(queue)
                if u in result:continue
                result[u]=label;expand(u,label,distance)
            if len(result)!=len(members):raise AssertionError('Disconnected source region')
            child=members[np.array([result[int(i)] for i in members])==1]
            ca=float(self.area[child].sum())
            if min(len(child),len(members)-len(child))<self.cfg.min_faces or min(ca,area[region]-ca)<self.cfg.min_area_fraction:continue
            other=members[np.array([result[int(i)] for i in members])==0]
            interface=[e for u in child for v,e in self.adj[u] if labels[v]==region and result[v]==0]
            if self.evidence.certify(other,child) is not None or self.freeform.certify(interface) is not None:
                self.report['surface_split_vetoes']+=1
                continue
            B=self.B[child];w=self.area[child]
            m1=np.einsum('nki,nkj,n->ij',B,B,w);b1=np.einsum('nki,nk,n->i',B,self.target[child],w)
            e1=self.fit(m1,b1,ca)[0];e0=self.fit(matrix[region]-m1,rhs[region]-b1,area[region]-ca)[0]
            cut=sum(self.cost[e] for u in child for v,e in self.adj[u] if labels[v]==region and result[v]==0)
            if e1+e0+self.cfg.region_penalty+cut<old-1e-9:
                labels[child]=next_label;next_label+=1;accepted+=1
        self.report['accepted_splits']+=accepted
        return labels,accepted

    def refine(self, labels):
        matrix,rhs,area,count=self.aggregate(labels)
        energies=np.array([self.fit(matrix[i],rhs[i],area[i])[0] for i in range(len(area))])
        # Keep a geometric envelope during this sweep. A network-driven
        # single-face move must not pull a certified surface into its neighbor.
        models={}
        frozen=set()
        for region in range(len(area)):
            group=np.flatnonzero(labels==region)
            previous=self._freeform_groups.get(int(group[0]))
            if previous is not None and np.array_equal(previous,group):
                frozen.add(region)
                continue
            for kind in ('plane','revolution','sphere','torus','graph2','graph'):
                model=self.evidence.fit(kind,group)
                if model is not None and self.evidence.residual(model,group)<=1:
                    models[region]=model;break
        moved=0
        def removal_connected(face,region):
            neighbors={v for v,e in self.adj[face] if labels[v]==region}
            if len(neighbors)<=1:return True
            first=next(iter(neighbors));seen={first};front=[(first,0)]
            while front:
                u,depth=front.pop()
                if depth>=6:continue
                for v,e in self.adj[u]:
                    if v!=face and labels[v]==region and v not in seen:
                        seen.add(v);front.append((v,depth+1))
            return neighbors.issubset(seen)
        boundary=np.flatnonzero(np.array([any(labels[v]!=labels[u] for v,e in self.adj[u]) for u in range(self.n)]))
        for u in boundary:
            source=int(labels[u]);w=self.area[u]
            if source in frozen:continue
            destinations={int(labels[v]) for v,e in self.adj[u] if labels[v]!=source}
            if not destinations or count[source]<=self.cfg.min_faces or area[source]-w<self.cfg.min_area_fraction:continue
            if not removal_connected(int(u),source):continue
            B=self.B[u];m=w*(B.T@B);b=w*(B.T@self.target[u])
            source_energy=self.fit(matrix[source]-m,rhs[source]-b,area[source]-w)[0]
            best=None
            for dest in sorted(destinations):
                if dest in frozen:continue
                if dest in models and self.evidence.residual(models[dest],[u])>1:continue
                if source in models and dest in models:
                    if self.evidence.residual(models[source],[u])+0.1<self.evidence.residual(models[dest],[u]):continue
                dest_energy=self.fit(matrix[dest]+m,rhs[dest]+b,area[dest]+w)[0]
                pair=sum(self.cost[e]*(int(dest!=labels[v])-int(source!=labels[v])) for v,e in self.adj[u])
                delta=source_energy+dest_energy-energies[source]-energies[dest]+pair
                if delta<-1e-10 and (best is None or delta<best[0]):best=(delta,dest,dest_energy)
            if best is not None:
                _,dest,dest_energy=best
                labels[u]=dest;matrix[source]-=m;rhs[source]-=b;area[source]-=w;count[source]-=1;energies[source]=source_energy
                matrix[dest]+=m;rhs[dest]+=b;area[dest]+=w;count[dest]+=1;energies[dest]=dest_energy;moved+=1
        self.report['refinement_moves']+=moved
        return labels,moved

    def energy(self, labels):
        matrix,rhs,area,count=self.aggregate(labels)
        geometry=sum(self.fit(matrix[i],rhs[i],area[i])[0] for i in range(len(area)))
        cut=labels[self.uv[:,0]]!=labels[self.uv[:,1]]
        boundary=float(self.cost[self.internal_ids][cut].sum())
        regions=len(area)*self.cfg.region_penalty
        return {'geometry':geometry,'boundary':boundary,'region_count_penalty':regions,'total':geometry+boundary+regions}

    def run(self, log=print):
        started=time.perf_counter()
        labels=self.initial_regions();self.report['initial_regions']=int(labels.max()+1)
        log(f'Connected micro-regions: {labels.max()+1}')
        labels=self.coarsen(labels);self.report['after_energy_merging']=int(labels.max()+1)
        log(f'Energy-based merge: {labels.max()+1} regions; surface certificates={sum(self.report["surface_merges"].values())}')
        for _ in range(self.cfg.split_passes):
            labels,n=self.split(labels)
            if not n:break
            labels=self.coarsen(labels)
        self.report['energy_before_minimum']=self.energy(labels)
        labels=self.coarsen(labels,enforce_minimum=True)
        labels=self.coarsen(labels,certificates_only=True)
        self.report['energy_after_minimum']=self.energy(labels)
        log(f'Minimum-support enforcement: {labels.max()+1} regions; forced merges={self.report["forced_merges"]}')
        for _ in range(self.cfg.refine_passes):
            labels,n=self.refine(labels)
            if not n:break
            # Boundary repair can remove contaminated interface triangles and
            # make a previously rejected continuation observable. Reuse the
            # very same merge rule; never add a relaxed final merge threshold.
            labels=self.coarsen(labels,certificates_only=True)
        self.validate(labels)
        self.report['final_energy']=self.energy(labels)
        self.report['elapsed_seconds']=time.perf_counter()-started
        log(f'Validated {labels.max()+1} connected patches, {self.report["refinement_moves"]} boundary moves')
        return labels,self.report

    def validate(self, labels):
        if len(labels)!=self.n or labels.min()<0:raise AssertionError('Incomplete face labels')
        labels=np.unique(labels,return_inverse=True)[1]
        counts=np.bincount(labels);areas=np.bincount(labels,weights=self.area)
        if counts.min()<self.cfg.min_faces or areas.min()+1e-12<self.cfg.min_area_fraction:raise AssertionError('Minimum-support constraint violated')
        visited=np.zeros(self.n,dtype=bool);seen=set()
        for seed in range(self.n):
            if visited[seed]:continue
            label=int(labels[seed])
            if label in seen:raise AssertionError('Disconnected patch')
            seen.add(label);visited[seed]=True;stack=[seed]
            while stack:
                u=stack.pop()
                for v,e in self.adj[u]:
                    if not visited[v] and labels[v]==label:visited[v]=True;stack.append(v)
        boundary=np.zeros(len(self.incident),dtype=bool)
        boundary[self.internal_ids]=labels[self.uv[:,0]]!=labels[self.uv[:,1]]
        boundary[self.incident[:,1]<0]=True
        perimeter=np.zeros(len(counts))
        for e in np.flatnonzero(boundary):
            for f in self.incident[e]:
                if f>=0:perimeter[labels[f]]+=self.length[e]
        actual_area=self.area*np.linalg.norm(np.cross(self.vertices[self.faces[:,1]]-self.vertices[self.faces[:,0]],self.vertices[self.faces[:,2]]-self.vertices[self.faces[:,0]]),axis=1).sum()/2/self.scale**2
        normalized_area=np.bincount(labels,weights=actual_area)
        compactness=perimeter**2/np.maximum(4*np.pi*normalized_area,1e-20)
        self.report.update({'patch_count':len(counts),'all_faces_assigned':True,'all_patches_connected':True,'minimum_support_satisfied':True,
                            'minimum_patch_faces':int(counts.min()),'minimum_patch_area_fraction':float(areas.min()),
                            'low_probability_cut_edges':int(np.sum(boundary & np.isfinite(self.probabilities) & (self.probabilities<.3))),
                            'high_probability_uncut_edges':int(np.sum(~boundary & np.isfinite(self.probabilities) & (self.probabilities>.7))),
                            'patches':[{'patch_id':i+1,'faces':int(counts[i]),'area_fraction':float(areas[i]),'perimeter_compactness':float(compactness[i]),'elongated_review':bool(compactness[i]>25)} for i in range(len(counts))]})


def export_results(out,vertices,faces,predictions,labels,report,model_path,prob_path):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    for existing in ['face_labels.csv','patches.obj','patches.ply','segmentation.json','report.json','boundary_edges.csv']:
        if (out/existing).exists():raise ValueError('Output already exists; use a new output directory: '+str(out))
    with (out/'face_labels.csv').open('w',newline='',encoding='utf-8') as f:
        writer=csv.writer(f);writer.writerow(['triangle_id','patch_id']);writer.writerows(enumerate((labels+1).tolist(),1))
    with (out/'patches.obj').open('w',encoding='utf-8') as f:
        f.write('# Geometry preserved; each group is one connected patch. Face order in this OBJ is grouped.\n')
        for v in vertices:f.write('v '+' '.join(format(x,'.17g') for x in v)+'\n')
        for label in range(int(labels.max())+1):
            f.write(f'g patch_{label+1}\n')
            for face in faces[labels==label]:f.write('f '+' '.join(str(i+1) for i in face)+'\n')
    palette=np.asarray([colorsys.hsv_to_rgb((i*.61803398875)%1,.55,.88) for i in range(int(labels.max())+1)])
    colors=(palette[labels]*255).astype('u1')
    records=np.empty(len(faces)*3,dtype=[('x','<f4'),('y','<f4'),('z','<f4'),('red','u1'),('green','u1'),('blue','u1')])
    flat=vertices[faces].reshape(-1,3)
    for i,key in enumerate(('x','y','z')):records[key]=flat[:,i]
    for i,key in enumerate(('red','green','blue')):records[key]=np.repeat(colors[:,i],3)
    fs=np.empty(len(faces),dtype=[('n','u1'),('v','<i4',(3,))]);fs['n']=3;fs['v']=np.arange(len(faces)*3).reshape(-1,3)
    with (out/'patches.ply').open('wb') as f:
        f.write(f'ply\nformat binary_little_endian 1.0\ncomment face order preserved; readout patches\nelement vertex {len(records)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n'.encode())
        records.tofile(f);fs.tofile(f)
    ids,endpoints,incident,p=predictions
    with (out/'boundary_edges.csv').open('w',newline='',encoding='utf-8') as f:
        writer=csv.writer(f);writer.writerow(['edge_id','vertex_1','vertex_2','triangle_1','triangle_2','boundary_probability','patch_1','patch_2','is_cut'])
        for i,(u,v) in enumerate(incident):
            writer.writerow([int(ids[i]),int(endpoints[i,0])+1,int(endpoints[i,1])+1,int(u)+1,int(v)+1,float(p[i]),int(labels[u])+1,int(labels[v])+1 if v>=0 else 0,int(v<0 or labels[u]!=labels[v])])
    sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
    metadata={'schema':'edgescope.segmentation.v1','model_file':Path(model_path).name,'model_sha256':sha(model_path),'probability_sha256':sha(prob_path),'face_count':len(faces),'patch_count':int(labels.max())+1,'labels':(labels+1).tolist()}
    (out/'segmentation.json').write_text(json.dumps(metadata,separators=(',',':')),encoding='utf-8')
    report['input']={'model':str(Path(model_path).resolve()),'probabilities':str(Path(prob_path).resolve()),'model_sha256':metadata['model_sha256'],'probability_sha256':metadata['probability_sha256']}
    (out/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mesh',required=True);parser.add_argument('--probabilities',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--min-faces',type=int,default=80);parser.add_argument('--min-area',type=float,default=.0004)
    parser.add_argument('--normal-sigma',type=float,default=.20);parser.add_argument('--distance-edges',type=float,default=.35)
    parser.add_argument('--boundary-weight',type=float,default=.002);parser.add_argument('--region-penalty',type=float,default=.0008)
    parser.add_argument('--continuation-distance',type=float,default=.60)
    parser.add_argument('--continuation-normal',type=float,default=.40)
    parser.add_argument('--continuation-curvature',type=float,default=.25)
    parser.add_argument('--continuation-min-faces',type=int,default=48)
    parser.add_argument('--freeform-probability',type=float,default=.15)
    parser.add_argument('--freeform-curvature',type=float,default=.50)
    parser.add_argument('--freeform-outlier-fraction',type=float,default=.08)
    parser.add_argument('--freeform-ridge-contrast',type=float,default=.15)
    args=parser.parse_args()
    config=Config(min_faces=args.min_faces,min_area_fraction=args.min_area,normal_sigma=args.normal_sigma,distance_edges=args.distance_edges,boundary_weight=args.boundary_weight,region_penalty=args.region_penalty,
                  continuation_distance=args.continuation_distance,continuation_normal=args.continuation_normal,
                  continuation_curvature=args.continuation_curvature,continuation_min_faces=args.continuation_min_faces,
                  freeform_probability=args.freeform_probability,freeform_curvature=args.freeform_curvature,
                  freeform_outlier_fraction=args.freeform_outlier_fraction,freeform_ridge_contrast=args.freeform_ridge_contrast)
    print('Reading mesh and validating full edge correspondence...',flush=True)
    vertices,faces=load_mesh(args.mesh);predictions=read_predictions(args.probabilities)
    positions=validate_mapping(vertices,faces,predictions,Path(args.mesh).suffix.lower()=='.obj')
    solver=Readout(vertices,faces,predictions[2],predictions[3],positions,config)
    labels,report=solver.run(log=lambda s:print(s,flush=True))
    export_results(args.out,vertices,faces,predictions,labels,report,args.mesh,args.probabilities)
    print(json.dumps({k:report[k] for k in ['patch_count','minimum_patch_faces','minimum_patch_area_fraction','low_probability_cut_edges','high_probability_uncut_edges','elapsed_seconds']},ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
