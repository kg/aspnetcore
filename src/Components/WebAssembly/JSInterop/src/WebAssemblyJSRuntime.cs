// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Microsoft.JSInterop.Infrastructure;
using WebAssembly.JSInterop;
using System.Runtime.CompilerServices;

namespace Microsoft.JSInterop.WebAssembly;

/// <summary>
/// Provides methods for invoking JavaScript functions for applications running
/// on the Mono WebAssembly runtime.
/// </summary>
public abstract class WebAssemblyJSRuntime : JSInProcessRuntime, IJSUnmarshalledRuntime
{
    /// <summary>
    /// Initializes a new instance of <see cref="WebAssemblyJSRuntime"/>.
    /// </summary>
    protected WebAssemblyJSRuntime()
    {
        JsonSerializerOptions.Converters.Insert(0, new WebAssemblyJSObjectReferenceJsonConverter(this));
    }

    /// <inheritdoc />
    protected override string InvokeJS(string identifier, string? argsJson, JSCallResultType resultType, long targetInstanceId)
    {
        var callInfo = new JSCallInfo
        {
            FunctionIdentifier = identifier,
            TargetInstanceId = targetInstanceId,
            ResultType = resultType,
            MarshalledCallArgsJson = argsJson ?? "[]",
            MarshalledCallAsyncHandle = default
        };

        InternalCalls.InvokeJSRef<object, object, object, string>(ref callInfo, out string result, out string exception, null, null, null);

        return exception != null
            ? throw new JSException(exception)
            : result;
    }

    /// <inheritdoc />
    protected override void BeginInvokeJS(long asyncHandle, string identifier, string? argsJson, JSCallResultType resultType, long targetInstanceId)
    {
        var callInfo = new JSCallInfo
        {
            FunctionIdentifier = identifier,
            TargetInstanceId = targetInstanceId,
            ResultType = resultType,
            MarshalledCallArgsJson = argsJson ?? "[]",
            MarshalledCallAsyncHandle = asyncHandle
        };

        InternalCalls.InvokeJSRef<object, object, object, string>(ref callInfo, out _, out _, null, null, null);
    }

    /// <inheritdoc />
    [UnconditionalSuppressMessage("ReflectionAnalysis", "IL2026:RequiresUnreferencedCode", Justification = "TODO: This should be in the xml suppressions file, but can't be because https://github.com/mono/linker/issues/2006")]
    protected override unsafe void EndInvokeDotNet(DotNetInvocationInfo callInfo, in DotNetInvocationResult dispatchResult)
    {
        var resultJsonOrErrorMessage = dispatchResult.Success
            ? dispatchResult.ResultJson!
            : dispatchResult.Exception!.ToString();
#pragma warning disable CS0618 // Type or member is obsolete
        var cid = callInfo.CallId;
        InvokeUnmarshalled<IntPtr, bool, IntPtr, object>("Blazor._internal.endInvokeDotNetFromJSRef",
            (IntPtr)Unsafe.AsPointer(ref cid), dispatchResult.Success, (IntPtr)Unsafe.AsPointer(ref resultJsonOrErrorMessage));
#pragma warning restore CS0618 // Type or member is obsolete
    }

    /// <inheritdoc />
    protected override unsafe void SendByteArray(int id, byte[] data)
    {
#pragma warning disable CS0618 // Type or member is obsolete
        var pData = (IntPtr)Unsafe.AsPointer(ref data);
        InvokeUnmarshalled<int, IntPtr, object>("Blazor._internal.receiveByteArrayRef", id, pData);
#pragma warning restore CS0618 // Type or member is obsolete
    }

    [Obsolete("This method is obsolete. Use JSImportAttribute instead.")]
    internal TResult InvokeUnmarshalled<T0, T1, T2, TResult>(string identifier, T0 arg0, T1 arg1, T2 arg2, long targetInstanceId)
    {
        var resultType = JSCallResultTypeHelper.FromGeneric<TResult>();

        var callInfo = new JSCallInfo
        {
            FunctionIdentifier = identifier,
            TargetInstanceId = targetInstanceId,
            ResultType = resultType,
        };

        string exception;

        switch (resultType)
        {
            case JSCallResultType.Default:
            case JSCallResultType.JSVoidResult:
                InternalCalls.InvokeJSRef<T0, T1, T2, TResult>(ref callInfo, out TResult result, out exception, arg0, arg1, arg2);
                return exception != null
                    ? throw new JSException(exception)
                    : result;
            case JSCallResultType.JSObjectReference:
                InternalCalls.InvokeJSRef<T0, T1, T2, int>(ref callInfo, out int id, out exception, arg0, arg1, arg2);
                return exception != null
                    ? throw new JSException(exception)
                    : (TResult)(object)new WebAssemblyJSObjectReference(this, id);
            case JSCallResultType.JSStreamReference:
                InternalCalls.InvokeJSRef<T0, T1, T2, string>(ref callInfo, out string serializedStreamReference, out exception, arg0, arg1, arg2);
                return exception != null
                    ? throw new JSException(exception)
                    : (TResult)(object)DeserializeJSStreamReference(serializedStreamReference);
            default:
                throw new InvalidOperationException($"Invalid result type '{resultType}'.");
        }
    }

    [UnconditionalSuppressMessage("ReflectionAnalysis", "IL2026:RequiresUnreferencedCode", Justification = "IJSStreamReference is referenced in Microsoft.JSInterop.Infrastructure.JSStreamReferenceJsonConverter")]
    private IJSStreamReference DeserializeJSStreamReference(string serializedStreamReference)
    {
        var jsStreamReference = JsonSerializer.Deserialize<IJSStreamReference>(serializedStreamReference, JsonSerializerOptions);
        if (jsStreamReference is null)
        {
            throw new NullReferenceException($"Unable to parse the {nameof(serializedStreamReference)}.");
        }

        return jsStreamReference;
    }

    /// <inheritdoc />
    [Obsolete("This method is obsolete. Use JSImportAttribute instead.")]
    public TResult InvokeUnmarshalled<TResult>(string identifier)
        => InvokeUnmarshalled<object?, object?, object?, TResult>(identifier, null, null, null, 0);

    /// <inheritdoc />
    [Obsolete("This method is obsolete. Use JSImportAttribute instead.")]
    public TResult InvokeUnmarshalled<T0, TResult>(string identifier, T0 arg0)
        => InvokeUnmarshalled<T0, object?, object?, TResult>(identifier, arg0, null, null, 0);

    /// <inheritdoc />
    [Obsolete("This method is obsolete. Use JSImportAttribute instead.")]
    public TResult InvokeUnmarshalled<T0, T1, TResult>(string identifier, T0 arg0, T1 arg1)
        => InvokeUnmarshalled<T0, T1, object?, TResult>(identifier, arg0, arg1, null, 0);

    /// <inheritdoc />
    [Obsolete("This method is obsolete. Use JSImportAttribute instead.")]
    public TResult InvokeUnmarshalled<T0, T1, T2, TResult>(string identifier, T0 arg0, T1 arg1, T2 arg2)
        => InvokeUnmarshalled<T0, T1, T2, TResult>(identifier, arg0, arg1, arg2, 0);
}
