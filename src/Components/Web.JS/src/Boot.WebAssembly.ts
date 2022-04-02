// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

/* eslint-disable array-element-newline */
import { DotNet } from '@microsoft/dotnet-js-interop';
import { Blazor } from './GlobalExports';
import * as Environment from './Environment';
import { byteArrayBeingTransferred, Module, BINDING, MONO, monoPlatform } from './Platform/Mono/MonoPlatform';
import { renderBatch, getRendererer, attachRootComponentToElement, attachRootComponentToLogicalElement } from './Rendering/Renderer';
import { SharedMemoryRenderBatch } from './Rendering/RenderBatch/SharedMemoryRenderBatch';
import { shouldAutoStart } from './BootCommon';
import { WebAssemblyResourceLoader } from './Platform/WebAssemblyResourceLoader';
import { WebAssemblyConfigLoader } from './Platform/WebAssemblyConfigLoader';
import { BootConfigResult } from './Platform/BootConfig';
import { Pointer, System_Boolean, System_Int, System_Object_Ref, System_String, System_String_Ref } from './Platform/Platform';
import { WebAssemblyStartOptions } from './Platform/WebAssemblyStartOptions';
import { WebAssemblyComponentAttacher } from './Platform/WebAssemblyComponentAttacher';
import { discoverComponents, discoverPersistedState, WebAssemblyComponentDescriptor } from './Services/ComponentDescriptorDiscovery';
import { setDispatchEventMiddleware } from './Rendering/WebRendererInteropMethods';
import { fetchAndInvokeInitializers } from './JSInitializers/JSInitializers.WebAssembly';

let started = false;

async function boot(options?: Partial<WebAssemblyStartOptions>): Promise<void> {

  if (started) {
    throw new Error('Blazor has already started.');
  }
  started = true;

  if (inAuthRedirectIframe()) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await new Promise(() => {}); // See inAuthRedirectIframe for explanation
  }

  setDispatchEventMiddleware((browserRendererId, eventHandlerId, continuation) => {
    // It's extremely unusual, but an event can be raised while we're in the middle of synchronously applying a
    // renderbatch. For example, a renderbatch might mutate the DOM in such a way as to cause an <input> to lose
    // focus, in turn triggering a 'change' event. It may also be possible to listen to other DOM mutation events
    // that are themselves triggered by the application of a renderbatch.
    const renderer = getRendererer(browserRendererId);
    if (renderer.eventDelegator.getHandler(eventHandlerId)) {
      monoPlatform.invokeWhenHeapUnlocked(continuation);
    }
  });

  Blazor._internal.applyHotReload = (id: string, metadataDelta: string, ilDelta: string, pdbDelta: string | undefined) => {
    DotNet.invokeMethod('Microsoft.AspNetCore.Components.WebAssembly', 'ApplyHotReloadDelta', id, metadataDelta, ilDelta, pdbDelta);
  };

  Blazor._internal.getApplyUpdateCapabilities = () => DotNet.invokeMethod('Microsoft.AspNetCore.Components.WebAssembly', 'GetApplyUpdateCapabilities');

  // Configure JS interop
  Blazor._internal.invokeJSFromDotNetRef = invokeJSFromDotNetRef;
  Blazor._internal.endInvokeDotNetFromJSRef = endInvokeDotNetFromJSRef;
  Blazor._internal.receiveByteArrayRef = receiveByteArrayRef;
  Blazor._internal.retrieveByteArrayRef = retrieveByteArrayRef;

  // Configure environment for execution under Mono WebAssembly with shared-memory rendering
  const platform = Environment.setPlatform(monoPlatform);
  Blazor.platform = platform;

  const renderBatchCallback = (hazardBuffer: any, browserRendererId: number, batchAddress: Pointer) => {
    // Store the batch address into the hazard buffer to pin it
    batchAddress = hazardBuffer.set(0, batchAddress);
    // Now store the arrays it points to into the hazard buffer as well to pin them
    // RenderBatch.cs lists four ArrayRange fields and each ArrayRange is a (T[] arr, int count) pair
    for (let i = 0; i < 4; i++) {
      const offset = <any>batchAddress + (i * 8);
      hazardBuffer.copy_value_from_address(i + 1, offset);
    }
    const batch = new SharedMemoryRenderBatch(batchAddress);
    renderBatch(browserRendererId, batch);
  };

  Blazor._internal.renderBatch = (browserRendererId: number, batchAddress: Pointer) => {
    // We're going to read directly from the .NET memory heap, so indicate to the platform
    // that we don't want anything to modify the memory contents during this time. Currently this
    // is only guaranteed by the fact that .NET code doesn't run during this time, but in the
    // future (when multithreading is implemented) we might need the .NET runtime to understand
    // that GC compaction isn't allowed during this critical section.
    const heapLock = monoPlatform.beginHeapLock();
    try {
      MONO.mono_wasm_with_hazard_buffer(16, renderBatchCallback, browserRendererId, batchAddress);
    } finally {
      heapLock.release();
    }
  };

  // Configure navigation via JS Interop
  const getBaseUri = Blazor._internal.navigationManager.getBaseURI;
  const getLocationHref = Blazor._internal.navigationManager.getLocationHref;
  Blazor._internal.navigationManager.getUnmarshalledBaseURI = () => BINDING.js_string_to_mono_string(getBaseUri());
  Blazor._internal.navigationManager.getUnmarshalledLocationHref = () => BINDING.js_string_to_mono_string(getLocationHref());

  Blazor._internal.navigationManager.listenForNavigationEvents(async (uri: string, state: string | undefined, intercepted: boolean): Promise<void> => {
    await DotNet.invokeMethodAsync(
      'Microsoft.AspNetCore.Components.WebAssembly',
      'NotifyLocationChanged',
      uri,
      state,
      intercepted
    );
  }, async (callId: number, uri: string, state: string | undefined, intercepted: boolean): Promise<void> => {
    const shouldContinueNavigation = await DotNet.invokeMethodAsync<boolean>(
      'Microsoft.AspNetCore.Components.WebAssembly',
      'NotifyLocationChangingAsync',
      uri,
      state,
      intercepted
    );

    Blazor._internal.navigationManager.endLocationChanging(callId, shouldContinueNavigation);
  });

  const candidateOptions = options ?? {};

  // Get the custom environment setting and blazorBootJson loader if defined
  const environment = candidateOptions.environment;

  // Fetch the resources and prepare the Mono runtime
  const bootConfigPromise = BootConfigResult.initAsync(candidateOptions.loadBootResource, environment);

  // Leverage the time while we are loading boot.config.json from the network to discover any potentially registered component on
  // the document.
  const discoveredComponents = discoverComponents(document, 'webassembly') as WebAssemblyComponentDescriptor[];
  const componentAttacher = new WebAssemblyComponentAttacher(discoveredComponents);
  Blazor._internal.registeredComponents = {
    getRegisteredComponentsCount: () => componentAttacher.getCount(),
    getId: (index) => componentAttacher.getId(index),
    getAssembly: (id) => BINDING.js_string_to_mono_string(componentAttacher.getAssembly(id)),
    getTypeName: (id) => BINDING.js_string_to_mono_string(componentAttacher.getTypeName(id)),
    getParameterDefinitions: (id) => BINDING.js_string_to_mono_string(componentAttacher.getParameterDefinitions(id) || ''),
    getParameterValues: (id) => BINDING.js_string_to_mono_string(componentAttacher.getParameterValues(id) || ''),
  };

  Blazor._internal.getPersistedState = () => BINDING.js_string_to_mono_string(discoverPersistedState(document) || '');

  Blazor._internal.attachRootComponentToElement = (selector, componentId, rendererId: any) => {
    const element = componentAttacher.resolveRegisteredElement(selector);
    if (!element) {
      attachRootComponentToElement(selector, componentId, rendererId);
    } else {
      attachRootComponentToLogicalElement(rendererId, element, componentId, false);
    }
  };

  const bootConfigResult: BootConfigResult = await bootConfigPromise;
  const jsInitializer = await fetchAndInvokeInitializers(bootConfigResult.bootConfig, candidateOptions);

  const [resourceLoader] = await Promise.all([
    WebAssemblyResourceLoader.initAsync(bootConfigResult.bootConfig, candidateOptions || {}),
    WebAssemblyConfigLoader.initAsync(bootConfigResult),
  ]);

  try {
    await platform.start(resourceLoader);
  } catch (ex) {
    throw new Error(`Failed to start platform. Reason: ${ex}`);
  }

  // Start up the application
  platform.callEntryPoint(resourceLoader.bootConfig.entryAssembly);
  // At this point .NET has been initialized (and has yielded), we can't await the promise becasue it will
  // only end when the app finishes running
  jsInitializer.invokeAfterStartedCallbacks(Blazor);
}

// obsolete, legacy, don't use for new code!
function invokeJSFromDotNetRef(callInfo: Pointer, resultAddress: System_Object_Ref, arg0: any, arg1: any, arg2: any): void {
  // NOTE: This function stores non-managed-pointer things into resultRoot! Under *any other circumstances*,
  //  this is incorrect and you should not do it! However, in this case the caller is providing the storage
  //  for this root, so if the caller is asking us to put a regular int in there, we can trust that they are
  //  not providing us an address that is meant to house a managed pointer, so the GC won't touch it and crash.
  const resultRoot = MONO.mono_wasm_new_external_root<System_String>(<any>resultAddress);
  const functionIdentifier = monoPlatform.readStringField(callInfo, 0)!;
  const resultType = monoPlatform.readInt32Field(callInfo, 4);
  const marshalledCallArgsJson = monoPlatform.readStringField(callInfo, 8);
  const targetInstanceId = monoPlatform.readUint64Field(callInfo, 20);

  try {
    resultRoot.clear();

    if (marshalledCallArgsJson !== null) {
      const marshalledCallAsyncHandle = monoPlatform.readUint64Field(callInfo, 12);

      if (marshalledCallAsyncHandle !== 0) {
        DotNet.jsCallDispatcher.beginInvokeJSFromDotNet(marshalledCallAsyncHandle, functionIdentifier, marshalledCallArgsJson, resultType, targetInstanceId);
      } else {
        const resultJson = DotNet.jsCallDispatcher.invokeJSFromDotNet(functionIdentifier, marshalledCallArgsJson, resultType, targetInstanceId)!;
        if (resultJson !== null) {
          BINDING.js_string_to_mono_string_root(resultJson, resultRoot);
        }
      }
    } else {
      const func = DotNet.jsCallDispatcher.findJSFunction(functionIdentifier, targetInstanceId);
      const result = func.call(null, arg0, arg1, arg2);

      switch (resultType) {
        case DotNet.JSCallResultType.Default:
          resultRoot.value = result;
          return;
        case DotNet.JSCallResultType.JSObjectReference:
          resultRoot.value = DotNet.createJSObjectReference(result).__jsObjectId;
          return;
        case DotNet.JSCallResultType.JSStreamReference: {
          const streamReference = DotNet.createJSStreamReference(result);
          const resultJson = JSON.stringify(streamReference);
          BINDING.js_string_to_mono_string_root(resultJson, resultRoot);
          return;
        }
        case DotNet.JSCallResultType.JSVoidResult:
          return;
        default:
          throw new Error(`Invalid JS call result type '${resultType}'.`);
      }
    }
  } finally {
    resultRoot.release();
  }
}

function endInvokeDotNetFromJSRef(callId: System_String_Ref, success: System_Boolean, resultJsonOrErrorMessage: System_String_Ref): void {
  const callIdRoot = MONO.mono_wasm_new_external_root<System_String>(<any>callId);
  const resultJsonOrErrorMessageRoot = MONO.mono_wasm_new_external_root<System_String>(<any>resultJsonOrErrorMessage);
  try {
    const callIdString = BINDING.conv_string_root(callIdRoot)!;
    const successBool = (success as any as number) !== 0;
    const resultJsonOrErrorMessageString = BINDING.conv_string_root(resultJsonOrErrorMessageRoot)!;
    DotNet.jsCallDispatcher.endInvokeDotNetFromJS(callIdString, successBool, resultJsonOrErrorMessageString);
  } finally {
    callIdRoot.release();
    resultJsonOrErrorMessageRoot.release();
  }
}

function receiveByteArrayRef(id: System_Int, data: System_Object_Ref): void {
  const idLong = id as unknown as number;
  const dataByteArray = BINDING.mono_primitive_array_to_js_typed_array_ref(Uint8Array, data as any, true, true);
  DotNet.jsCallDispatcher.receiveByteArray(idLong, dataByteArray);
}

function retrieveByteArrayRef(result: System_Object_Ref): void {
  if (byteArrayBeingTransferred === null) {
    throw new Error('Byte array not available for transfer');
  }

  const resultRoot = MONO.mono_wasm_new_external_root(result as any);
  try {
    BINDING.js_typed_array_to_array_root(byteArrayBeingTransferred, resultRoot as any);
  } finally {
    resultRoot.release();
  }
}

function inAuthRedirectIframe(): boolean {
  // We don't want the .NET runtime to start up a second time inside the AuthenticationService.ts iframe. It uses resources
  // unnecessarily and can lead to errors (#37355), plus the behavior is not well defined as the frame will be terminated shortly.
  // So, if we're in that situation, block the startup process indefinitely so that anything chained to Blazor.start never happens.
  // The detection logic here is based on the equivalent check in AuthenticationService.ts.
  // TODO: Later we want AuthenticationService.ts to become responsible for doing this via a JS initializer. Doing it here is a
  //       tactical fix for .NET 6 so we don't have to change how authentication is initialized.
  if (window.parent !== window && !window.opener && window.frameElement) {
    const settingsJson = window.sessionStorage && window.sessionStorage['Microsoft.AspNetCore.Components.WebAssembly.Authentication.CachedAuthSettings'];
    const settings = settingsJson && JSON.parse(settingsJson);
    return settings && settings.redirect_uri && location.href.startsWith(settings.redirect_uri);
  }

  return false;
}

Blazor.start = boot;
if (shouldAutoStart()) {
  boot().catch(error => {
    if (typeof Module !== 'undefined' && Module.printErr) {
      // Logs it, and causes the error UI to appear
      Module.printErr(error);
    } else {
      // The error must have happened so early we didn't yet set up the error UI, so just log to console
      console.error(error);
    }
  });
}
