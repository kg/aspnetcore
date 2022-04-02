// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { Pointer, System_String, System_Array, System_Object, System_Object_Ref } from '../Platform';

// Mono uses this global to hang various debugging-related items on

declare interface MONO {
  loaded_files: string[];
  mono_wasm_runtime_ready (): void;
  mono_wasm_setenv (name: string, value: string): void;
  mono_wasm_load_data_archive (data: Uint8Array, prefix: string): void;
  mono_wasm_load_bytes_into_heap (data: Uint8Array): Pointer;
  mono_wasm_load_icu_data (heapAddress: Pointer): boolean;
  mono_wasm_new_root_buffer (...args): any;
  mono_wasm_new_root (value?: System_Object): WasmRoot;
  mono_wasm_new_external_root (address: System_Object_Ref): WasmRoot;
  mono_wasm_release_roots (...args: WasmRoot[]): void;
  mono_wasm_with_hazard_buffer (...args): unknown;
  mono_wasm_with_pinned_object (...args): unknown;
  mono_wasm_memcpy_from_managed_object (destination: Pointer, destination_offset: number, destination_size_bytes: number, source_object: System_Object_Ref, source_offset: number, count_bytes: number): void;
  mono_wasm_copy_managed_pointer_from_field (destination: System_Object_Ref, source_object: System_Object_Ref, field_offset: number): void;
}

// Mono uses this global to hold low-level interop APIs
declare interface BINDING {
  mono_obj_array_new(length: number): System_Array<System_Object>;
  mono_obj_array_set(array: System_Array<System_Object>, index: number, value: System_Object): void;
  js_string_to_mono_string(jsString: string): System_String;
  js_typed_array_to_array(array: Uint8Array): System_Object;
  js_to_mono_obj(jsObject: unknown) : System_Object;
  mono_array_to_js_array<TInput, TOutput>(array: System_Array<TInput>) : Array<TOutput>;
  conv_string(dotnetString: System_String | null): string | null;
  bind_static_method(fqn: string, signature?: string): Function;
  call_assembly_entry_point(assemblyName: string, args: unknown[], signature: unknown): Promise<unknown>;
  unbox_mono_obj(object: System_Object): unknown;
}

export interface WasmRoot {
  address: System_Object_Ref;
  value: System_Object;
  clear (): void;
  release (): void;
}

declare global {
  let MONO: MONO;
  let BINDING: BINDING;
}
