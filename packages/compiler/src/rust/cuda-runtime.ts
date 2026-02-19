type RuntimeKernelScalar = "i32" | "u32" | "f32" | "f64" | "bool";

type RuntimeKernelParam =
  | { readonly name: string; readonly kind: "scalar"; readonly scalar: RuntimeKernelScalar }
  | { readonly name: string; readonly kind: "global_ptr"; readonly scalar: RuntimeKernelScalar };

export type RuntimeKernelDecl = {
  readonly name: string;
  readonly params: readonly RuntimeKernelParam[];
};

export function renderCudaRuntimeModule(kernels: readonly RuntimeKernelDecl[]): string {
  const lines: string[] = [];
  lines.push("// @tsuba/gpu CUDA runtime (v0)");
  lines.push("#[allow(dead_code)]");
  lines.push("#[allow(non_snake_case)]");
  lines.push("#[allow(non_camel_case_types)]");
  lines.push("mod __tsuba_cuda {");
  lines.push("  use std::ffi::{c_void, CStr, CString};");
  lines.push("  use std::marker::PhantomData;");
  lines.push("  use std::mem::size_of;");
  lines.push("  use std::os::raw::{c_char, c_int};");
  lines.push("  use std::ptr::{null, null_mut};");
  lines.push("  use std::sync::{Mutex, OnceLock};");
  lines.push("");
  lines.push("  #[cfg(not(unix))]");
  lines.push('  compile_error!("@tsuba/gpu: CUDA runtime only supports unix targets in v0.");');
  lines.push("");
  lines.push("  #[cfg(unix)]");
  lines.push("  const RTLD_NOW: c_int = 2;");
  lines.push("");
  lines.push("  #[cfg(unix)]");
  lines.push("  #[link(name = \"dl\")]");
  lines.push("  extern \"C\" {");
  lines.push("    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;");
  lines.push("    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;");
  lines.push("    fn dlerror() -> *const c_char;");
  lines.push("  }");
  lines.push("");
  lines.push("  type CUresult = i32;");
  lines.push("  type CUdevice = i32;");
  lines.push("  type CUcontext = *mut c_void;");
  lines.push("  type CUmodule = *mut c_void;");
  lines.push("  type CUfunction = *mut c_void;");
  lines.push("  type CUstream = *mut c_void;");
  lines.push("  type CUdeviceptr = u64;");
  lines.push("");
  lines.push("  type FnCuInit = unsafe extern \"C\" fn(flags: u32) -> CUresult;");
  lines.push("  type FnCuDeviceGet = unsafe extern \"C\" fn(device: *mut CUdevice, ordinal: i32) -> CUresult;");
  lines.push("  type FnCuCtxCreate = unsafe extern \"C\" fn(pctx: *mut CUcontext, flags: u32, dev: CUdevice) -> CUresult;");
  lines.push("  type FnCuCtxDestroy = unsafe extern \"C\" fn(ctx: CUcontext) -> CUresult;");
  lines.push("  type FnCuCtxSynchronize = unsafe extern \"C\" fn() -> CUresult;");
  lines.push("  type FnCuCtxSetCurrent = unsafe extern \"C\" fn(ctx: CUcontext) -> CUresult;");
  lines.push("  type FnCuMemAlloc = unsafe extern \"C\" fn(dptr: *mut CUdeviceptr, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuMemFree = unsafe extern \"C\" fn(dptr: CUdeviceptr) -> CUresult;");
  lines.push("  type FnCuMemcpyHtoD = unsafe extern \"C\" fn(dst: CUdeviceptr, src: *const c_void, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuMemcpyDtoH = unsafe extern \"C\" fn(dst: *mut c_void, src: CUdeviceptr, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuModuleLoadData = unsafe extern \"C\" fn(module: *mut CUmodule, image: *const c_void) -> CUresult;");
  lines.push("  type FnCuModuleGetFunction = unsafe extern \"C\" fn(hfunc: *mut CUfunction, module: CUmodule, name: *const c_char) -> CUresult;");
  lines.push("  type FnCuLaunchKernel = unsafe extern \"C\" fn(");
  lines.push("    f: CUfunction,");
  lines.push("    gridX: u32, gridY: u32, gridZ: u32,");
  lines.push("    blockX: u32, blockY: u32, blockZ: u32,");
  lines.push("    sharedMemBytes: u32,");
  lines.push("    hStream: CUstream,");
  lines.push("    kernelParams: *mut *mut c_void,");
  lines.push("    extra: *mut *mut c_void");
  lines.push("  ) -> CUresult;");
  lines.push("  type FnCuGetErrorName = unsafe extern \"C\" fn(error: CUresult, pStr: *mut *const c_char) -> CUresult;");
  lines.push("  type FnCuGetErrorString = unsafe extern \"C\" fn(error: CUresult, pStr: *mut *const c_char) -> CUresult;");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  struct Api {");
  lines.push("    lib: *mut c_void,");
  lines.push("    cuInit: FnCuInit,");
  lines.push("    cuDeviceGet: FnCuDeviceGet,");
  lines.push("    cuCtxCreate_v2: FnCuCtxCreate,");
  lines.push("    cuCtxDestroy_v2: FnCuCtxDestroy,");
  lines.push("    cuCtxSynchronize: FnCuCtxSynchronize,");
  lines.push("    cuCtxSetCurrent: FnCuCtxSetCurrent,");
  lines.push("    cuMemAlloc_v2: FnCuMemAlloc,");
  lines.push("    cuMemFree_v2: FnCuMemFree,");
  lines.push("    cuMemcpyHtoD_v2: FnCuMemcpyHtoD,");
  lines.push("    cuMemcpyDtoH_v2: FnCuMemcpyDtoH,");
  lines.push("    cuModuleLoadData: FnCuModuleLoadData,");
  lines.push("    cuModuleGetFunction: FnCuModuleGetFunction,");
  lines.push("    cuLaunchKernel: FnCuLaunchKernel,");
  lines.push("    cuGetErrorName: FnCuGetErrorName,");
  lines.push("    cuGetErrorString: FnCuGetErrorString,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn dl_last_error() -> String {");
  lines.push("    let p = dlerror();");
  lines.push("    if p.is_null() {");
  lines.push("      return \"<dlerror returned null>\".to_string();");
  lines.push("    }");
  lines.push("    CStr::from_ptr(p).to_string_lossy().to_string()");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_libcuda() -> *mut c_void {");
  lines.push("    for name in [\"libcuda.so.1\", \"libcuda.so\"] {");
  lines.push("      let c = CString::new(name).unwrap();");
  lines.push("      let h = dlopen(c.as_ptr(), RTLD_NOW);");
  lines.push("      if !h.is_null() {");
  lines.push("        return h;");
  lines.push("      }");
  lines.push("    }");
  lines.push("    panic!(\"@tsuba/gpu: failed to dlopen libcuda (tried libcuda.so.1, libcuda.so): {}\", dl_last_error());");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_sym(lib: *mut c_void, name: &str) -> *mut c_void {");
  lines.push("    let c = CString::new(name).unwrap();");
  lines.push("    let p = dlsym(lib, c.as_ptr());");
  lines.push("    if p.is_null() {");
  lines.push("      panic!(\"@tsuba/gpu: missing CUDA symbol {}: {}\", name, dl_last_error());");
  lines.push("    }");
  lines.push("    p");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_api() -> Api {");
  lines.push("    let lib = load_libcuda();");
  lines.push("    Api {");
  lines.push("      lib,");
  lines.push("      cuInit: std::mem::transmute(load_sym(lib, \"cuInit\")),");
  lines.push("      cuDeviceGet: std::mem::transmute(load_sym(lib, \"cuDeviceGet\")),");
  lines.push("      cuCtxCreate_v2: std::mem::transmute(load_sym(lib, \"cuCtxCreate_v2\")),");
  lines.push("      cuCtxDestroy_v2: std::mem::transmute(load_sym(lib, \"cuCtxDestroy_v2\")),");
  lines.push("      cuCtxSynchronize: std::mem::transmute(load_sym(lib, \"cuCtxSynchronize\")),");
  lines.push("      cuCtxSetCurrent: std::mem::transmute(load_sym(lib, \"cuCtxSetCurrent\")),");
  lines.push("      cuMemAlloc_v2: std::mem::transmute(load_sym(lib, \"cuMemAlloc_v2\")),");
  lines.push("      cuMemFree_v2: std::mem::transmute(load_sym(lib, \"cuMemFree_v2\")),");
  lines.push("      cuMemcpyHtoD_v2: std::mem::transmute(load_sym(lib, \"cuMemcpyHtoD_v2\")),");
  lines.push("      cuMemcpyDtoH_v2: std::mem::transmute(load_sym(lib, \"cuMemcpyDtoH_v2\")),");
  lines.push("      cuModuleLoadData: std::mem::transmute(load_sym(lib, \"cuModuleLoadData\")),");
  lines.push("      cuModuleGetFunction: std::mem::transmute(load_sym(lib, \"cuModuleGetFunction\")),");
  lines.push("      cuLaunchKernel: std::mem::transmute(load_sym(lib, \"cuLaunchKernel\")),");
  lines.push("      cuGetErrorName: std::mem::transmute(load_sym(lib, \"cuGetErrorName\")),");
  lines.push("      cuGetErrorString: std::mem::transmute(load_sym(lib, \"cuGetErrorString\")),");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  fn cu_error_str(api: &Api, err: CUresult) -> String {");
  lines.push("    unsafe {");
  lines.push("      let mut name_ptr: *const c_char = null();");
  lines.push("      let mut msg_ptr: *const c_char = null();");
  lines.push("      let _ = (api.cuGetErrorName)(err, &mut name_ptr);");
  lines.push("      let _ = (api.cuGetErrorString)(err, &mut msg_ptr);");
  lines.push("      let name = if name_ptr.is_null() { \"<unknown>\".to_string() } else { CStr::from_ptr(name_ptr).to_string_lossy().to_string() };");
  lines.push("      let msg = if msg_ptr.is_null() { \"<unknown>\".to_string() } else { CStr::from_ptr(msg_ptr).to_string_lossy().to_string() };");
  lines.push("      format!(\"{} ({}): {}\", name, err, msg)");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  fn check(api: &Api, res: CUresult, what: &str) {");
  lines.push("    if res == 0 { return; }");
  lines.push("    panic!(\"@tsuba/gpu: {} failed: {}\", what, cu_error_str(api, res));");
  lines.push("  }");
  lines.push("");
  lines.push("  struct State {");
  lines.push("    api: Api,");
  lines.push("    ctx: CUcontext,");
  lines.push("    lock: Mutex<()>,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe impl Send for State {}");
  lines.push("  unsafe impl Sync for State {}");
  lines.push("");
  lines.push("  static STATE: OnceLock<State> = OnceLock::new();");
  lines.push("");
  lines.push("  fn state() -> &'static State {");
  lines.push("    STATE.get_or_init(|| unsafe {");
  lines.push("      let api = load_api();");
  lines.push("      check(&api, (api.cuInit)(0), \"cuInit\");");
  lines.push("      let mut dev: CUdevice = 0;");
  lines.push("      check(&api, (api.cuDeviceGet)(&mut dev, 0), \"cuDeviceGet\");");
  lines.push("      let mut ctx: CUcontext = null_mut();");
  lines.push("      check(&api, (api.cuCtxCreate_v2)(&mut ctx, 0, dev), \"cuCtxCreate_v2\");");
  lines.push("      State { api, ctx, lock: Mutex::new(()) }");
  lines.push("    })");
  lines.push("  }");
  lines.push("");
  lines.push("  fn ensure_ctx_current(st: &State) {");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuCtxSetCurrent)(st.ctx), \"cuCtxSetCurrent\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  impl Drop for State {");
  lines.push("    fn drop(&mut self) {");
  lines.push("      unsafe {");
  lines.push("        let _ = (self.api.cuCtxDestroy_v2)(self.ctx);");
  lines.push("      }");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  pub struct DevicePtr<T> {");
  lines.push("    pub raw: CUdeviceptr,");
  lines.push("    _marker: PhantomData<T>,");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn device_malloc<T>(len: u32) -> DevicePtr<T> {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = (len as usize) * size_of::<T>();");
  lines.push("    if bytes == 0 {");
  lines.push("      return DevicePtr { raw: 0, _marker: PhantomData };");
  lines.push("    }");
  lines.push("    let mut dptr: CUdeviceptr = 0;");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemAlloc_v2)(&mut dptr, bytes), \"cuMemAlloc_v2\");");
  lines.push("    }");
  lines.push("    DevicePtr { raw: dptr, _marker: PhantomData }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn device_free<T>(ptr: DevicePtr<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    if ptr.raw == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemFree_v2)(ptr.raw), \"cuMemFree_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn memcpy_htod<T>(dst: DevicePtr<T>, src: &Vec<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = src.len() * size_of::<T>();");
  lines.push("    if bytes == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemcpyHtoD_v2)(dst.raw, src.as_ptr() as *const c_void, bytes), \"cuMemcpyHtoD_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn memcpy_dtoh<T>(dst: &mut Vec<T>, src: DevicePtr<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = dst.len() * size_of::<T>();");
  lines.push("    if bytes == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemcpyDtoH_v2)(dst.as_mut_ptr() as *mut c_void, src.raw, bytes), \"cuMemcpyDtoH_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  struct KernelFn {");
  lines.push("    #[allow(dead_code)]");
  lines.push("    module: CUmodule,");
  lines.push("    func: CUfunction,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe impl Send for KernelFn {}");
  lines.push("  unsafe impl Sync for KernelFn {}");
  lines.push("");
  lines.push("  unsafe fn load_kernel_fn(api: &Api, ptx: &str, name: &str) -> KernelFn {");
  lines.push("    let mut module: CUmodule = null_mut();");
  lines.push("    let ptx_c = CString::new(ptx).unwrap();");
  lines.push("    check(api, (api.cuModuleLoadData)(&mut module, ptx_c.as_ptr() as *const c_void), \"cuModuleLoadData\");");
  lines.push("    let mut func: CUfunction = null_mut();");
  lines.push("    let name_c = CString::new(name).unwrap();");
  lines.push("    check(api, (api.cuModuleGetFunction)(&mut func, module, name_c.as_ptr()), \"cuModuleGetFunction\");");
  lines.push("    KernelFn { module, func }");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn launch_kernel(api: &Api, func: CUfunction, grid_x: u32, grid_y: u32, grid_z: u32, block_x: u32, block_y: u32, block_z: u32, params: &mut [*mut c_void]) {");
  lines.push("    check(api, (api.cuLaunchKernel)(func, grid_x, grid_y, grid_z, block_x, block_y, block_z, 0, null_mut(), params.as_mut_ptr(), null_mut()), \"cuLaunchKernel\");");
  lines.push("    check(api, (api.cuCtxSynchronize)(), \"cuCtxSynchronize\");");
  lines.push("  }");

  for (const k of kernels) {
    const argList = k.params
      .map((p, idx) => {
        const rustTy = p.kind === "scalar" ? p.scalar : `DevicePtr<${p.scalar}>`;
        return `p${idx}: ${rustTy}`;
      })
      .join(", ");
    const args = argList.length === 0 ? "" : `, ${argList}`;
    lines.push("");
    lines.push(
      `  pub fn launch_${k.name}(grid_x: u32, grid_y: u32, grid_z: u32, block_x: u32, block_y: u32, block_z: u32${args}) {`
    );
    lines.push(
      `    let _ptx: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/kernels/${k.name}.ptx"));`
    );
    lines.push("    let st = state();");
    lines.push("    let _g = st.lock.lock().unwrap();");
    lines.push("    ensure_ctx_current(st);");
    lines.push("    static K: OnceLock<KernelFn> = OnceLock::new();");
    lines.push(`    let kf = K.get_or_init(|| unsafe { load_kernel_fn(&st.api, _ptx, "${k.name}") });`);
    for (let i = 0; i < k.params.length; i++) {
      const p = k.params[i]!;
      if (p.kind === "global_ptr") {
        lines.push(`    let mut a${i}: CUdeviceptr = p${i}.raw;`);
      } else {
        lines.push(`    let mut a${i}: ${p.scalar} = p${i};`);
      }
    }
    if (k.params.length === 0) {
      lines.push("    let mut params: [*mut c_void; 0] = [];");
    } else {
      const ptrs = k.params
        .map((_, i) => `(&mut a${i} as *mut _ as *mut c_void)`)
        .join(", ");
      lines.push(`    let mut params: [*mut c_void; ${k.params.length}] = [${ptrs}];`);
    }
    lines.push(
      "    unsafe { launch_kernel(&st.api, kf.func, grid_x, grid_y, grid_z, block_x, block_y, block_z, &mut params); }"
    );
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}
