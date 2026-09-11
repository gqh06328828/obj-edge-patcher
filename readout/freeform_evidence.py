"""Probability and local, multiscale evidence for freeform interfaces.

No global surface equation is required. Each removed interface is checked in
full; a short low-probability bridge cannot erase a mostly high-p boundary.
"""
from dataclasses import dataclass
import numpy as np
from surface_evidence import Surface, graph_basis, unit


@dataclass(frozen=True)
class FreeformCertificate:
    kind: str = 'freeform'


class FreeformEvidence:
    def __init__(self, solver):
        self.s = solver
        self.local_cache = {}
        self.background_cache = {}
        self.vertices=(solver.vertices-solver.center)/solver.scale

    def local_model(self, faces, origin, frame, positive):
        # Vertex positions sample the original surface. Facet normals live at
        # different effective positions on alternating remesh triangles; using
        # those as exact derivatives can create a false curvature jump.
        points=np.unique(self.vertices[np.unique(self.s.faces[faces])],axis=0)
        local=(points-origin) @ frame
        local=local[local[:,0]>=0] if positive else local[local[:,0]<=0]
        if len(local)<12:return None
        basis=graph_basis(local[:,:2])[0]
        span=max(np.linalg.norm(np.ptp(local[:,:2],axis=0)),1e-12)
        weights=np.exp(-np.sum(local[:,:2]**2,axis=1)/span**2)
        scale=np.maximum(np.linalg.norm(basis*weights[:,None],axis=0),1e-14)
        coeff,_,rank,_=np.linalg.lstsq(basis*weights[:,None]/scale,local[:,2]*weights,rcond=1e-8)
        if rank<10:return None
        return Surface('graph',origin,frame,coeff/scale)

    def background_probability(self,edge):
        edge=int(edge)
        if edge in self.background_cache:return self.background_cache[edge]
        s=self.s;a,b=map(int,s.incident[edge]);origin=(s.x[a]+s.x[b])/2
        normal=unit(s.normals[a]+s.normals[b]);direction=s.x[b]-s.x[a]
        direction=unit(direction-normal*(direction @ normal))
        seen={a,b};front=[a,b]
        for _ in range(7):
            following=[]
            for face in front:
                for neighbor,_ in s.adj[face]:
                    if neighbor not in seen:seen.add(neighbor);following.append(neighbor)
            front=following
        candidates=np.array(sorted({e for face in seen for _,e in s.adj[face]}),dtype=int)
        incident=s.incident[candidates]
        midpoint=(s.x[incident[:,0]]+s.x[incident[:,1]])/2
        offset=(midpoint-origin) @ direction
        background=[]
        for sign in (-1,1):
            sample=s.probabilities[candidates[sign*offset>1.2*s.length[edge]]]
            if len(sample)<3 or not np.isfinite(sample).all():
                background=[];break
            background.append(float(np.median(sample)))
        # A rise must stand above both sides. A diffuse high-p surface is not
        # itself a thin probability ridge. Missing support cannot erase a seam.
        result=max(background) if len(background)==2 else float('nan')
        self.background_cache[edge]=result
        return result

    def local_continuity(self, edge):
        """Check both sides of a mesh-local bisector at three neighborhood scales.

        The neighborhood and bisector depend only on the mesh, so the cached
        decision stays valid when region labels change. Unknown is not smooth.
        """
        edge = int(edge)
        if edge in self.local_cache:
            return self.local_cache[edge]
        s = self.s
        a,b = map(int,s.incident[edge])
        if b<0:
            return False
        normal=unit(s.normals[a]+s.normals[b])
        direction=s.x[b]-s.x[a]
        direction=unit(direction-normal*(direction @ normal))
        if min(np.linalg.norm(normal),np.linalg.norm(direction))<.9:
            self.local_cache[edge]=False
            return False
        frame=np.column_stack([direction,np.cross(normal,direction),normal])
        origin=(s.x[a]+s.x[b])/2
        depth={a:0,b:0};front=[a,b]
        for level in range(1,8):
            following=[]
            for face in front:
                for neighbor,_ in s.adj[face]:
                    if neighbor not in depth:
                        depth[neighbor]=level;following.append(neighbor)
            front=following
        accepted=False
        for rings in (3,5,7):
            ids=np.array([face for face,level in depth.items() if level<=rings],dtype=int)
            side=(s.x[ids]-origin) @ direction
            groups=[ids[side<0],ids[side>0]]
            if min(map(len,groups))<10:
                continue
            # Cubic local Taylor models estimate curvature *at the interface*.
            # Quadratic fits average each side's curvature and can mistake a
            # smooth curvature gradient for a jump. No global cubic is used.
            models=[self.local_model(g,origin,frame,bool(i)) for i,g in enumerate(groups)]
            if any(model is None for model in models):
                continue
            span=max(np.linalg.norm(np.ptp(s.x[ids],axis=0)),s.length[edge])
            evaluations=[model.evaluate(origin[None,:]) for model in models]
            da,na,ka=evaluations[0];db,nb,kb=evaluations[1]
            normal_jump=float(np.linalg.norm(na-nb))
            distance_jump=float(abs(da[0]-db[0]))
            curvature_jump=float(np.linalg.norm(ka-kb))
            curvature_scale=(float(np.linalg.norm(ka))+float(np.linalg.norm(kb)))/2
            # Require observable agreement; noisy/undersupported local fits
            # do not earn a more permissive curvature tolerance.
            residual_ok=True
            for model,g in zip(models,groups):
                distance,predicted,_=model.evaluate(s.x[g],curvature=False)
                if (np.quantile(abs(distance),.95)>s.sigma_d or
                    np.quantile(np.linalg.norm(predicted-s.raw_normals[g],axis=1),.95)>s.cfg.normal_sigma*.5):
                    residual_ok=False;break
            if (residual_ok and normal_jump<s.cfg.normal_sigma*.4 and
                distance_jump<s.length[edge]*.2 and
                curvature_jump<s.cfg.freeform_curvature*curvature_scale+.005/span):
                accepted=True
                break
        self.local_cache[edge]=accepted
        return accepted

    def certify(self, edges):
        s=self.s
        edges=np.asarray(edges,dtype=int)
        if not len(edges):return None
        probabilities=s.probabilities[edges]
        if not np.isfinite(probabilities).all():return None
        lengths=s.length[edges]
        total=float(lengths.sum())
        # Length statistics use the whole common boundary, never its weakest
        # edge or a sampled subset. There is no override of sustained high-p.
        mean_probability=float(np.sum(lengths*probabilities)/total)
        if np.sum(lengths[probabilities>.95])/total>.08:
            return None
        if mean_probability>s.cfg.freeform_probability or np.sum(lengths[probabilities>.5])/total>.10:
            if mean_probability>.85:return None
            background=np.array([self.background_probability(e) for e in edges])
            if not np.isfinite(background).all():return None
            contrast=np.maximum(0.,probabilities-background)
            ridge=(probabilities>.5)&(contrast>s.cfg.freeform_ridge_contrast)
            if np.sum(lengths[ridge])/total>.10 or np.sum(lengths*contrast)/total>.12:
                return None
        uv=s.incident[edges]
        angle=np.linalg.norm(s.raw_normals[uv[:,0]]-s.raw_normals[uv[:,1]],axis=1)
        if np.any(angle>2*np.sin(np.deg2rad(12))):
            return None
        failures=0.
        # Start with the most bent edges, which reject incompatible pairs
        # early. Every edge is still visited when a certificate is accepted.
        for i in np.argsort(-angle,kind='stable'):
            if not self.local_continuity(edges[i]):
                failures+=lengths[i]
                if failures/total>s.cfg.freeform_outlier_fraction:
                    return None
        return FreeformCertificate()
