"""Conservative, geometry-only certificates for removing an interface.

Models use distance and *unit* normals. In particular, cone gradient magnitude
is not forced to be constant. A certificate is evidence, not a CAD face label.
"""
from dataclasses import dataclass
import numpy as np


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-14)


@dataclass
class Surface:
    kind: str
    origin: np.ndarray
    frame: np.ndarray
    coeff: np.ndarray

    def evaluate(self, points, curvature=True):
        x = (points - self.origin) @ self.frame
        eye = np.eye(3)
        if self.kind == 'plane':
            normal = np.broadcast_to(self.coeff[:3], x.shape)
            distance = x @ self.coeff[:3] - self.coeff[3]
            jacobian = np.zeros((len(x), 3, 3)) if curvature else None
        elif self.kind == 'sphere':
            delta = x - self.coeff[:3]
            radius = np.linalg.norm(delta, axis=1)
            normal = unit(delta) * np.sign(self.coeff[3])
            distance = radius - abs(self.coeff[3])
            jacobian = (eye - normal[:, :, None]*normal[:, None, :]) * (np.sign(self.coeff[3])/np.maximum(radius, 1e-14))[:, None, None] if curvature else None
        elif self.kind == 'revolution':
            cx, cy, r, slope = self.coeff
            delta = x[:, :2] - [cx, cy]
            rho = np.linalg.norm(delta, axis=1)
            radial = np.column_stack([unit(delta), np.zeros(len(x))])
            sign = np.sign(r)
            normal = (sign*radial - np.array([0., 0., slope])) / np.sqrt(1+slope*slope)
            distance = (rho - sign*(r+slope*x[:, 2])) / np.sqrt(1+slope*slope)
            jacobian = (np.diag([1., 1., 0.]) - radial[:, :, None]*radial[:, None, :]) * (sign/np.maximum(rho*np.sqrt(1+slope*slope), 1e-14))[:, None, None] if curvature else None
        elif self.kind == 'torus':
            major, height, minor = self.coeff
            rho = np.linalg.norm(x[:, :2],axis=1)
            radial = np.column_stack([unit(x[:, :2]),np.zeros(len(x))])
            delta = np.column_stack([rho-major,x[:, 2]-height])
            radius = np.linalg.norm(delta,axis=1)
            profile = unit(delta)
            normal = np.sign(minor)*(profile[:, 0,None]*radial+profile[:, 1,None]*[0.,0.,1.])
            distance = radius-abs(minor)
            if curvature:
                meridian = -profile[:, 1,None]*radial+profile[:, 0,None]*[0.,0.,1.]
                azimuth = np.diag([1.,1.,0.])-radial[:, :,None]*radial[:,None,:]
                jacobian = np.sign(minor)*(meridian[:, :,None]*meridian[:,None,:]/np.maximum(radius,1e-14)[:,None,None]+azimuth*(profile[:,0]/np.maximum(rho,1e-14))[:,None,None])
        else:
            basis, dx, dy, dxx, dxy, dyy = graph_basis(x[:, :2])
            basis, dx, dy, dxx, dxy, dyy = [a[:, :len(self.coeff)] for a in (basis,dx,dy,dxx,dxy,dyy)]
            gx, gy = dx @ self.coeff, dy @ self.coeff
            gradient = np.column_stack([-gx, -gy, np.ones(len(x))])
            magnitude = np.linalg.norm(gradient, axis=1)
            normal = gradient/magnitude[:, None]
            distance = (x[:, 2]-basis @ self.coeff)/magnitude
            if not curvature:
                return distance, normal @ self.frame.T, None
            hessian = np.zeros((len(x), 3, 3))
            hessian[:, 0, 0] = -dxx @ self.coeff
            hessian[:, 0, 1] = hessian[:, 1, 0] = -dxy @ self.coeff
            hessian[:, 1, 1] = -dyy @ self.coeff
            projection = eye-normal[:, :, None]*normal[:, None, :]
            jacobian = projection @ hessian / magnitude[:, None, None]
        # Compare shape operators on the tangent plane, not arbitrary extensions.
        if not curvature:
            return distance, normal @ self.frame.T, None
        projection = eye-normal[:, :, None]*normal[:, None, :]
        jacobian = projection @ jacobian @ projection
        return distance, normal @ self.frame.T, self.frame @ jacobian @ self.frame.T


def graph_basis(x):
    a, b = x.T
    z, o = np.zeros(len(x)), np.ones(len(x))
    return (np.column_stack([o,a,b,a*a,a*b,b*b,a**3,a*a*b,a*b*b,b**3]),
            np.column_stack([z,o,z,2*a,b,z,3*a*a,2*a*b,b*b,z]),
            np.column_stack([z,z,o,z,a,2*b,z,a*a,2*a*b,3*b*b]),
            np.column_stack([z,z,z,2*o,z,z,6*a,2*b,z,z]),
            np.column_stack([z,z,z,z,o,z,z,2*a,2*b,z]),
            np.column_stack([z,z,z,z,z,2*o,z,z,2*a,6*b]))


def fit_surface(kind, points, normals, weights, distance_tol, frame=None, origin=None):
    """Area-weighted fit; invalid/poorly observed models abstain."""
    weights = weights/weights.sum()
    origin = np.sum(points*weights[:, None], axis=0) if origin is None else origin
    x = points-origin
    if kind == 'revolution' and frame is None:
        mean = np.sum(normals*weights[:, None], axis=0)
        covariance = (normals-mean).T @ ((normals-mean)*weights[:, None])
        values, vectors = np.linalg.eigh(covariance)
        if values[1] < .00001 or values[0] > .15*values[1]:
            return None
        axis = vectors[:, 0]
        helper = np.eye(3)[np.argmin(abs(axis))]
        u = unit(np.cross(axis, helper))
        frame = np.column_stack([u, np.cross(axis, u), axis])
    elif kind.startswith('graph') and frame is None:
        axis = unit(np.sum(normals*weights[:, None], axis=0))
        if np.linalg.norm(axis) < .9 or np.min(normals @ axis) < .65:
            return None
        u = unit(np.cross(axis, np.eye(3)[np.argmin(abs(axis))]))
        frame = np.column_stack([u, np.cross(axis, u), axis])
    if frame is None:
        frame = np.eye(3)
    x, n = x @ frame, normals @ frame
    root = np.sqrt(weights)
    if kind == 'plane':
        normal = unit(np.sum(n*weights[:, None], axis=0))
        coeff = np.r_[normal, np.sum((x @ normal)*weights)]
    elif kind == 'sphere':
        mean_x, mean_n = np.sum(x*weights[:, None], axis=0), np.sum(n*weights[:, None], axis=0)
        denominator = np.sum(weights*np.sum((n-mean_n)**2, axis=1))
        if denominator < .005:
            return None
        radius = np.sum(weights*np.sum((x-mean_x)*(n-mean_n), axis=1))/denominator
        if abs(radius) < distance_tol:
            return None
        coeff = np.r_[mean_x-radius*mean_n, radius]
    elif kind == 'revolution':
        radial = unit(n[:, :2])
        slope = float(np.sum(weights*(-n[:, 2]/np.maximum(np.linalg.norm(n[:, :2],axis=1),1e-12))))
        design = np.zeros((len(x), 2, 3))
        design[:, 0, 0] = design[:, 1, 1] = 1
        design[:, :, 2] = radial
        target = x[:, :2]-slope*x[:, 2, None]*radial
        base = np.linalg.lstsq((design*root[:, None, None]).reshape(-1, 3), (target*root[:, None]).ravel(), rcond=1e-10)[0]
        coeff = np.r_[base,slope]
        radii = coeff[2]+coeff[3]*x[:, 2]
        if np.min(abs(radii)) < distance_tol or np.any(radii*coeff[2] <= 0):
            return None
    elif kind == 'torus':
        rho = np.linalg.norm(x[:, :2],axis=1)
        radial = unit(x[:, :2])
        profile_normal = np.column_stack([np.sum(n[:, :2]*radial,axis=1),n[:,2]])
        # Tangential normal components would contradict this symmetry axis.
        if np.quantile(abs(n[:,0]*radial[:,1]-n[:,1]*radial[:,0]),.95)>.06:
            return None
        profile_points = np.column_stack([rho,x[:,2]])
        pn = np.sum(profile_normal*weights[:,None],axis=0)
        px = np.sum(profile_points*weights[:,None],axis=0)
        variance = np.sum(weights*np.sum((profile_normal-pn)**2,axis=1))
        if variance<.001:
            return None
        radius = np.sum(weights*np.sum((profile_points-px)*(profile_normal-pn),axis=1))/variance
        center = px-radius*pn
        if abs(radius)<distance_tol or center[0]<=abs(radius):
            return None
        coeff = np.r_[center,radius]
    else:
        if np.min(n[:, 2]) < .5:
            return None
        # Rescale columns so small mesh coordinates do not destroy cubic fits.
        basis, dx, dy, *_ = graph_basis(x[:, :2])
        columns = 6 if kind == 'graph2' else 10
        basis, dx, dy = [a[:, :columns] for a in (basis,dx,dy)]
        span = max(np.linalg.norm(np.ptp(x, axis=0)), distance_tol*10)
        design = np.concatenate([basis, dx*span*.2, dy*span*.2])
        target = np.r_[x[:, 2], -n[:, 0]/n[:, 2]*span*.2, -n[:, 1]/n[:, 2]*span*.2]
        w = np.tile(root, 3)
        scales = np.maximum(np.linalg.norm(design*w[:, None], axis=0), 1e-14)
        coeff, _, rank, _ = np.linalg.lstsq(design*w[:, None]/scales, target*w, rcond=1e-8)
        if rank < columns:
            return None
        coeff = coeff/scales
    return Surface(kind, origin, frame, coeff)


class SurfaceEvidence:
    def __init__(self, solver):
        self.solver = solver
        self.distance_tol = solver.sigma_d*solver.cfg.continuation_distance
        self.normal_tol = solver.cfg.normal_sigma*solver.cfg.continuation_normal
        # These are proposals, not labels. Every proposed axis still has to
        # pass distance, normal, cross-prediction and curvature validation.
        centered=solver.x-np.average(solver.x,axis=0,weights=solver.area)
        _,axes=np.linalg.eigh(centered.T @ (centered*solver.area[:,None]))
        self.axes=[]
        for axis in axes.T:
            self.axes.append(self.axis_reference(np.zeros(3),axis))

    @staticmethod
    def axis_reference(origin,axis):
        axis=unit(axis)
        u=unit(np.cross(axis,np.eye(3)[np.argmin(abs(axis))]))
        return Surface('torus',origin,np.column_stack([u,np.cross(axis,u),axis]),np.zeros(3))

    def axis_proposals(self,ids):
        s=self.solver
        origin=np.average(s.x[ids],axis=0,weights=s.area[ids])
        span=max(np.linalg.norm(np.ptp(s.x[ids],axis=0)),1e-10)
        x=(s.x[ids]-origin)/span;n=s.raw_normals[ids]
        design=np.column_stack([np.cross(x,n),n])*np.sqrt(s.area[ids,None])
        _,vectors=np.linalg.eigh(design.T @ design)
        proposals=list(self.axes)
        for value in vectors.T[:2]:
            magnitude=np.linalg.norm(value[:3])
            if magnitude<.1:continue
            axis=value[:3]/magnitude;moment=value[3:]/magnitude
            if abs(axis @ moment)>.1:continue
            center=origin+span*np.cross(axis,moment)
            proposals.append(self.axis_reference(center,axis))
        return proposals

    def sample(self, members):
        members = np.asarray(members, dtype=int)
        if len(members) <= self.solver.cfg.surface_samples:
            return members
        # Stratification by original triangle order is deterministic. All faces
        # are checked again before a certificate is accepted.
        return members[np.linspace(0, len(members)-1, self.solver.cfg.surface_samples, dtype=int)]

    def fit(self, kind, members, reference=None):
        ids = self.sample(members)
        s = self.solver
        if kind == 'revolution' and reference is None:
            candidates=[fit_surface(kind,s.x[ids],s.raw_normals[ids],s.area[ids],self.distance_tol)]
            candidates.extend(fit_surface(kind,s.x[ids],s.raw_normals[ids],s.area[ids],self.distance_tol,r.frame,r.origin) for r in self.axes)
            candidates=[model for model in candidates if model is not None]
            return min(candidates,key=lambda model:self.residual(model,ids),default=None)
        if kind == 'torus' and reference is None:
            candidates=[fit_surface(kind,s.x[ids],s.raw_normals[ids],s.area[ids],self.distance_tol,r.frame,r.origin) for r in self.axis_proposals(ids)]
            candidates=[model for model in candidates if model is not None]
            return min(candidates,key=lambda model:self.residual(model,ids),default=None)
        return fit_surface(kind, s.x[ids], s.raw_normals[ids], s.area[ids], self.distance_tol,
                           None if reference is None else reference.frame,
                           None if reference is None else reference.origin)

    def residual(self, model, members):
        if model is None:
            return float('inf')
        s = self.solver
        distance, normal, _ = model.evaluate(s.x[members],curvature=False)
        position = abs(distance)/self.distance_tol
        direction = np.linalg.norm(normal-s.raw_normals[members], axis=1)/self.normal_tol
        error = np.maximum(position, direction)
        if not np.isfinite(error).all():
            return float('inf')
        # A few remesh boundary triangles may straddle a true surface junction.
        # A hard tail cap prevents a narrow real strip hiding in the percentile.
        return max(float(np.quantile(error, .95)), float(np.max(error))/3)

    def certify(self, left, right):
        s = self.solver
        if min(len(left), len(right)) < s.cfg.continuation_min_faces:
            return None
        groups = [np.asarray(left), np.asarray(right)]
        samples = [self.sample(g) for g in groups]
        joint = np.concatenate(samples)
        span = max(float(np.linalg.norm(np.ptp(s.x[joint], axis=0))), self.distance_tol*10)
        for kind in ('plane', 'revolution', 'sphere', 'torus', 'graph2', 'graph'):
            common = self.fit(kind, joint)
            if common is None or any(self.residual(common, g) > 1 for g in samples):
                continue
            separate = [self.fit(kind, g, common if kind.startswith('graph') or kind in ('torus','revolution') else None) for g in samples]
            cross_limit = 2.5 if kind.startswith('graph') else 1.5
            # Bidirectional extrapolation: each side must explain the *other*
            # side. Similar average normals alone cannot certify a merge.
            if any(model is None or self.residual(model, joint) > cross_limit for model in separate):
                continue
            _, _, reference_curvature = common.evaluate(s.x[joint])
            _, _, ca = separate[0].evaluate(s.x[joint])
            _, _, cb = separate[1].evaluate(s.x[joint])
            difference = np.linalg.norm(ca-cb, axis=(1, 2))
            tolerance = s.cfg.continuation_curvature*np.linalg.norm(reference_curvature, axis=(1, 2)) + .005/span
            ratio=difference/np.maximum(tolerance,1e-12)
            if not np.isfinite(ratio).all() or max(np.quantile(ratio,.95),np.max(ratio)/3)>1:
                continue
            # Validate every original triangle on each side, not just a sample
            # or an area-averaged union. This is repeated after every merge.
            if any(self.residual(common, g) > 1 for g in groups):
                continue
            if any(self.residual(model, groups[1-i]) > cross_limit for i, model in enumerate(separate)):
                continue
            return common
        return None
