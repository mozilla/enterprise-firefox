/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CryptoIOInterposer.h"

#include <algorithm>
#include <stdio.h>
#include <vector>
#include <unordered_map>
#include <cmath>

#include <io.h>
#include <windows.h>
#include <winternl.h>

#include "mozilla/Assertions.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/FileUtilsWin.h"
#include "mozilla/IOInterposer.h"
#include "mozilla/Mutex.h"
#include "mozilla/NativeNt.h"
#include "mozilla/SmallArrayLRUCache.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/UniquePtr.h"
#include "nsTArray.h"
#include "nsWindowsDllInterceptor.h"

namespace {

// Keep track of cryptoed state. Notice that there is no reason to lock access
// to this variable as it's only changed in InitCryptoIOInterposer and
// ClearCryptoIOInterposer which may only be called on the main-thread when no
// other threads are running.
static bool sIOCryptoed = false;

/************************ Internal NT API Declarations ************************/

/*
 * Function pointer declaration for internal NT routine to create/open files.
 * For documentation on the NtCreateFile routine, see MSDN.
 */
typedef NTSTATUS(NTAPI* NtCreateFileFn)(
    PHANDLE aFileHandle, ACCESS_MASK aDesiredAccess,
    POBJECT_ATTRIBUTES aObjectAttributes, PIO_STATUS_BLOCK aIoStatusBlock,
    PLARGE_INTEGER aAllocationSize, ULONG aFileAttributes, ULONG aShareAccess,
    ULONG aCreateDisposition, ULONG aCreateOptions, PVOID aEaBuffer,
    ULONG aEaLength);

/*
 * Function pointer declaration for internal NT routine to create/open files.
 * For documentation on the NtOpenFile routine, see MSDN.
 */
typedef NTSTATUS(NTAPI* NtOpenFileFn)(
    PHANDLE aFileHandle, ACCESS_MASK aDesiredAccess,
    POBJECT_ATTRIBUTES aObjectAttributes, PIO_STATUS_BLOCK aIoStatusBlock,
    ULONG aShareAccess, ULONG aOpenOptions);

/**
 * Function pointer declaration for internal NT routine to close a handle.
 */
typedef NTSTATUS(NTAPI* NtCloseFn)(HANDLE aFileHandle);

/**
 * Function pointer declaration for internal NT routine to read data from file.
 * For documentation on the NtReadFile routine, see ZwReadFile on MSDN.
 */
typedef NTSTATUS(NTAPI* NtReadFileFn)(HANDLE aFileHandle, HANDLE aEvent,
                                      PIO_APC_ROUTINE aApc, PVOID aApcCtx,
                                      PIO_STATUS_BLOCK aIoStatus, PVOID aBuffer,
                                      ULONG aLength, PLARGE_INTEGER aOffset,
                                      PULONG aKey);

/**
 * Function pointer declaration for internal NT routine to read data from file.
 * No documentation exists, see wine sources for details.
 */
typedef NTSTATUS(NTAPI* NtReadFileScatterFn)(
    HANDLE aFileHandle, HANDLE aEvent, PIO_APC_ROUTINE aApc, PVOID aApcCtx,
    PIO_STATUS_BLOCK aIoStatus, FILE_SEGMENT_ELEMENT* aSegments, ULONG aLength,
    PLARGE_INTEGER aOffset, PULONG aKey);

/**
 * Function pointer declaration for internal NT routine to write data to file.
 * For documentation on the NtWriteFile routine, see ZwWriteFile on MSDN.
 */
typedef NTSTATUS(NTAPI* NtWriteFileFn)(HANDLE aFileHandle, HANDLE aEvent,
                                       PIO_APC_ROUTINE aApc, PVOID aApcCtx,
                                       PIO_STATUS_BLOCK aIoStatus,
                                       PVOID aBuffer, ULONG aLength,
                                       PLARGE_INTEGER aOffset, PULONG aKey);

/**
 * Function pointer declaration for internal NT routine to write data to file.
 * No documentation exists, see wine sources for details.
 */
typedef NTSTATUS(NTAPI* NtWriteFileGatherFn)(
    HANDLE aFileHandle, HANDLE aEvent, PIO_APC_ROUTINE aApc, PVOID aApcCtx,
    PIO_STATUS_BLOCK aIoStatus, FILE_SEGMENT_ELEMENT* aSegments, ULONG aLength,
    PLARGE_INTEGER aOffset, PULONG aKey);

/**
 * Function pointer declaration for internal NT routine to flush to disk.
 * For documentation on the NtFlushBuffersFile routine, see ZwFlushBuffersFile
 * on MSDN.
 */
typedef NTSTATUS(NTAPI* NtFlushBuffersFileFn)(HANDLE aFileHandle,
                                              PIO_STATUS_BLOCK aIoStatusBlock);

typedef struct _FILE_NETWORK_OPEN_INFORMATION* PFILE_NETWORK_OPEN_INFORMATION;
/**
 * Function pointer delaration for internal NT routine to query file attributes.
 * (equivalent to stat)
 */
typedef NTSTATUS(NTAPI* NtQueryFullAttributesFileFn)(
    POBJECT_ATTRIBUTES aObjectAttributes,
    PFILE_NETWORK_OPEN_INFORMATION aFileInformation);

/*************************** Auxiliary Declarations ***************************/

std::unordered_map<HANDLE, nsString> handlesOfInterest{};

bool IsFileUnderProfile(nsAString& aFilename) {
  if (mozilla::profileRoot.Length() == 0) {
    return false;
  }
  return FindInReadable(mozilla::profileRoot, aFilename);
}

bool isFileHandleTracked(HANDLE aFileHandle) {
  return handlesOfInterest.find(aFileHandle) != handlesOfInterest.end();
}

void trackFileHandleIfUnderProfile(HANDLE aFileHandle, POBJECT_ATTRIBUTES aObjectAttributes) {
  const wchar_t* buf =
      aObjectAttributes ? aObjectAttributes->ObjectName->Buffer : L"";
  uint32_t len = aObjectAttributes
                     ? aObjectAttributes->ObjectName->Length / sizeof(WCHAR)
                     : 0;
  nsDependentSubstring filename(buf, len);

  if (aFileHandle && IsFileUnderProfile(filename)) {
    DWORD fileAttributes = GetFileAttributes(aObjectAttributes->ObjectName->Buffer);
    if (INVALID_FILE_ATTRIBUTES != fileAttributes) {
      // Filter to make sure we only care for actual files.
      if (!(fileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        if (isFileHandleTracked(aFileHandle)) {
          const char* existingFilename = strdup(NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get());
          printf_stderr("DUPLICATED HANDLE: %p for '%s' (existing) and '%s' (new)\n", aFileHandle, existingFilename, NS_ConvertUTF16toUTF8(filename).get());
          MOZ_CRASH("Existing file handle");
        }
        handlesOfInterest[aFileHandle] = filename;
      }
    }
  }
}

// ROT13
void encrypt(ULONG bytes, void* buffer) {
  char* buf = (char*)buffer;
  for (ULONG i = 0; i < bytes; ++i) {
    char n_c = ((char*)(buffer))[i] - 13;
    buf[i] = n_c;
  }
}

void decrypt(ULONG bytes, void* buffer) {
  for (ULONG i = 0; i < bytes; ++i) {
    char n_c = ((char*)(buffer))[i] + 13;
    ((char*)buffer)[i] = n_c;
  }
}

/*************************** IO Interposing Methods ***************************/

// Function pointers to original functions
static mozilla::WindowsDllInterceptor::FuncHookType<NtCreateFileFn>
    gOriginalNtCreateFile;
static mozilla::WindowsDllInterceptor::FuncHookType<NtOpenFileFn>
    gOriginalNtOpenFile;
static mozilla::WindowsDllInterceptor::FuncHookType<NtCloseFn>
    gOriginalNtClose;
static mozilla::WindowsDllInterceptor::FuncHookType<NtReadFileFn>
    gOriginalNtReadFile;
static mozilla::WindowsDllInterceptor::FuncHookType<NtReadFileScatterFn>
    gOriginalNtReadFileScatter;
static mozilla::WindowsDllInterceptor::FuncHookType<NtWriteFileFn>
    gOriginalNtWriteFile;
static mozilla::WindowsDllInterceptor::FuncHookType<NtWriteFileGatherFn>
    gOriginalNtWriteFileGather;

static NTSTATUS NTAPI InterposedNtCreateFile(
    PHANDLE aFileHandle, ACCESS_MASK aDesiredAccess,
    POBJECT_ATTRIBUTES aObjectAttributes, PIO_STATUS_BLOCK aIoStatusBlock,
    PLARGE_INTEGER aAllocationSize, ULONG aFileAttributes, ULONG aShareAccess,
    ULONG aCreateDisposition, ULONG aCreateOptions, PVOID aEaBuffer,
    ULONG aEaLength) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtCreateFile);

  // Execute original function
  NTSTATUS status = gOriginalNtCreateFile(
      aFileHandle, aDesiredAccess, aObjectAttributes, aIoStatusBlock,
      aAllocationSize, aFileAttributes, aShareAccess, aCreateDisposition,
      aCreateOptions, aEaBuffer, aEaLength);

  if (NT_SUCCESS(status)) {
    trackFileHandleIfUnderProfile(*aFileHandle, aObjectAttributes);
  }

  return status;
}

static NTSTATUS NTAPI InterposedNtOpenFile(
    PHANDLE aFileHandle, ACCESS_MASK aDesiredAccess,
    POBJECT_ATTRIBUTES aObjectAttributes, PIO_STATUS_BLOCK aIoStatusBlock,
    ULONG aShareAccess, ULONG aOpenOptions) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtOpenFile);

  // Execute original function
  NTSTATUS status = gOriginalNtOpenFile(
      aFileHandle, aDesiredAccess, aObjectAttributes, aIoStatusBlock,
      aShareAccess, aOpenOptions);

  if (NT_SUCCESS(status)) {
    trackFileHandleIfUnderProfile(*aFileHandle, aObjectAttributes);
  }

  return status;
}

static NTSTATUS NTAPI InterposedNtClose(HANDLE aFileHandle) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtClose);

  // Execute original function
  NTSTATUS realStatus = gOriginalNtClose(aFileHandle);

  // Remove handle
  if (NT_SUCCESS(realStatus) && isFileHandleTracked(aFileHandle)) {
    size_t removed = handlesOfInterest.erase(aFileHandle);
    // printf_stderr("%s: %s %p REMOVED\n", "NtCloseFile", NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get(), aFileHandle);
    MOZ_ASSERT(removed == 1, "Removed one entry");
  }

  return realStatus;
}

#define BLOCK_SIZE 128

/**
 * get the blocks to read/write, based on BLOCK_SIZE
 *
 * returns first/last blocks (included) to read/write from
 *
 * First block is defined as the one that contains the offset position
 * Last block is definded as the one that contains the (offset + length - 1) position
 *   -> (length/offset - 1) because indexing starts at 0
 *
#define GET_BLOCKS(f, l, ef, el) { \
    printf("read %d@%d, expect to read from blocks (%d, %d)\n", f, l, ef, el); \
    size_t first, last; compute_blocks(f, l, &first, &last); \
    assert(first == ef); assert(last == el);
}

    //         length, offset, expected first, expected last
    GET_BLOCKS(1,      0,      0,              0);
    GET_BLOCKS(128,    0,      0,              0);
    GET_BLOCKS(128,    1,      0,              1);
    GET_BLOCKS(128,    1,      0,              1);
    GET_BLOCKS(128,    2,      0,              1);
    GET_BLOCKS(256,    1,      0,              2);
    GET_BLOCKS(256,    64,     0,              2);
    GET_BLOCKS(320,    64,     0,              2);
    GET_BLOCKS(320,    96,     0,              3);
    GET_BLOCKS(1,      127,    0,              0);
    GET_BLOCKS(1,      128,    1,              1);
    GET_BLOCKS(1,      127,    0,              0);
    GET_BLOCKS(2,      127,    0,              1);

 **/
void compute_blocks(size_t aLength, size_t aOffset, size_t* first, size_t* last)
{
    size_t firstBlock = std::floor((double)aOffset / (double)BLOCK_SIZE);
    size_t lastBlock  = std::floor(((double)aOffset + (double)aLength - 1.0) / (double)BLOCK_SIZE);

    *first = firstBlock;
    *last = lastBlock;
}

size_t blocks_access_size(size_t first, size_t last) {
  return ((last - first) + 1) * BLOCK_SIZE;
}

static NTSTATUS NTAPI InterposedNtReadFile(HANDLE aFileHandle, HANDLE aEvent,
                                           PIO_APC_ROUTINE aApc, PVOID aApcCtx,
                                           PIO_STATUS_BLOCK aIoStatus,
                                           PVOID aBuffer, ULONG aLength,
                                           PLARGE_INTEGER aOffset,
                                           PULONG aKey) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtReadFile);

  // Perform decryption
  if (isFileHandleTracked(aFileHandle)) {
    const char* filename = strdup(NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get());

    // Do a real read because aLength may not be the real data on disk and code
    // calling us may depend on this, e.g. sqlite3
    NTSTATUS realStatus = gOriginalNtReadFile(aFileHandle, aEvent, aApc, aApcCtx, aIoStatus, aBuffer, aLength, aOffset, aKey);
    if (NT_SUCCESS(realStatus)) {
      ULONG realLength = aIoStatus->Information;
      size_t offset = aOffset ? aOffset->QuadPart : 0;
      size_t firstBlock = 0, lastBlock = 0;
      compute_blocks(realLength, offset, &firstBlock, &lastBlock);
      size_t readSpan = blocks_access_size(firstBlock, lastBlock);
      void* encryptedBlocksBuffer = (void*)malloc(sizeof(char) * readSpan);
      memset(encryptedBlocksBuffer, '0', readSpan);
      IO_STATUS_BLOCK encryptedIoStatus;
      LARGE_INTEGER encryptedOffset = { .QuadPart = static_cast<LONGLONG>(firstBlock * BLOCK_SIZE) };

      NTSTATUS encryptedBlocksStatus = gOriginalNtReadFile(aFileHandle, nullptr, nullptr, nullptr, &encryptedIoStatus, encryptedBlocksBuffer, readSpan, &encryptedOffset, nullptr);
      if (NT_SUCCESS(encryptedBlocksStatus)) {
        for (size_t block = 0; block < (lastBlock - firstBlock); block++) {
          decrypt(BLOCK_SIZE, (void*)(((char*)encryptedBlocksBuffer) + (block * BLOCK_SIZE)));
        }
        void* decryptedBlocksBuffer = encryptedBlocksBuffer;
        void* offsetInDecryptedBlocksBuffer = (void*)(((char*)decryptedBlocksBuffer) + (offset - BLOCK_SIZE * firstBlock));
        // printf_stderr("%s: %s => encryptedBlocksBuffer=%p offsetInBuffer=%zu\n", "NtReadFile", filename, encryptedBlocksBuffer, (offset - BLOCK_SIZE * firstBlock));
        // int same = memcmp(aBuffer, offsetInDecryptedBlocksBuffer, realLength);
        // printf_stderr("%s: %s(%lu @ %zu) => memcmp(%p, %p, %lu)=%d == %s\n", "NtReadFile", filename, aLength, offset, aBuffer, offsetInDecryptedBlocksBuffer, realLength, same, same == 0 ? "IDENTICAL" : "DIFFERENT");
        // printf_stderr("%s: %s(%lu @ %zu) => memcpy(%p, %p, %lu)\n", "NtReadFile", filename, aLength, offset, aBuffer, offsetInDecryptedBlocksBuffer, realLength);
        memcpy(aBuffer, offsetInDecryptedBlocksBuffer, realLength);
        /* } else {
          printf_stderr("%s: %s (%lu@%lld) == [%zu; %zu] => %zu\n", "NtReadFile", NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get(), aLength, offset, firstBlock, lastBlock, blocks_access_size(firstBlock, lastBlock));
          printf_stderr("%s: %s readSpan=%zu offset=%zu readBytes=%lld ==> %s\n", "ENCRYPTED gOriginalNtReadFile", NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get(), readSpan, firstBlock * BLOCK_SIZE, encryptedIoStatus.Information, NT_SUCCESS(encryptedBlocksStatus) ? "SUCCESS" : "FAILURE");
        */
      }
      free(encryptedBlocksBuffer);
      // printf_stderr("%s: %s aLength=%lu aIoStatus = { .Status = %08lx, .Information=%lld } realStatus=%08lx ; encryptedIoStatus = { .Status = %08lx, .Information=%lld } encryptedBlocksStatus=%08lx\n", "NtReadFile", filename, aLength, aIoStatus->Status, aIoStatus->Information, realStatus, encryptedIoStatus.Status, encryptedIoStatus.Information, encryptedBlocksStatus);
    }

    return realStatus;
  } else {
    return gOriginalNtReadFile(aFileHandle, aEvent, aApc, aApcCtx, aIoStatus, aBuffer, aLength, aOffset, aKey);
  }
}

static NTSTATUS NTAPI InterposedNtReadFileScatter(
    HANDLE aFileHandle, HANDLE aEvent, PIO_APC_ROUTINE aApc, PVOID aApcCtx,
    PIO_STATUS_BLOCK aIoStatus, FILE_SEGMENT_ELEMENT* aSegments, ULONG aLength,
    PLARGE_INTEGER aOffset, PULONG aKey) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtReadFileScatter);

  // Execute original function
  NTSTATUS realStatus = gOriginalNtReadFileScatter(aFileHandle, aEvent, aApc, aApcCtx,
                                    aIoStatus, aSegments, aLength, aOffset,
                                    aKey);

  // Perform decryption
  if (NT_SUCCESS(realStatus) && isFileHandleTracked(aFileHandle)) {
    printf_stderr("%s: %s %p\n", "NtReadFileScatter", NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get(), aFileHandle);
  }

  return realStatus;
}

// Interposed NtWriteFile function
static NTSTATUS NTAPI InterposedNtWriteFile(HANDLE aFileHandle, HANDLE aEvent,
                                            PIO_APC_ROUTINE aApc, PVOID aApcCtx,
                                            PIO_STATUS_BLOCK aIoStatus,
                                            PVOID aBuffer, ULONG aLength,
                                            PLARGE_INTEGER aOffset,
                                            PULONG aKey) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtWriteFile);

  // Perform encryption
  if (isFileHandleTracked(aFileHandle)) {
    const char* filename = strdup(NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get());

      size_t offset = aOffset ? aOffset->QuadPart : 0;
      size_t firstBlock = 0, lastBlock = 0;
      compute_blocks(aLength, offset, &firstBlock, &lastBlock);
      size_t writeSpan = blocks_access_size(firstBlock, lastBlock);
      void* encryptedBlocksBuffer = (void*)malloc(sizeof(char) * writeSpan);
      memset(encryptedBlocksBuffer, 0x42, writeSpan);
      IO_STATUS_BLOCK encryptedIoStatus;
      LARGE_INTEGER encryptedOffset = { .QuadPart = static_cast<LONGLONG>(firstBlock * BLOCK_SIZE) };

      // read the encrypted existing data that may exist
      NTSTATUS encryptedBlocksStatus = gOriginalNtReadFile(aFileHandle, nullptr, nullptr, nullptr, &encryptedIoStatus, encryptedBlocksBuffer, writeSpan, &encryptedOffset, nullptr);
      if (NT_SUCCESS(encryptedBlocksStatus)) {
        // decrypt blocks
        for (size_t block = 0; block < (lastBlock - firstBlock); block++) {
          decrypt(BLOCK_SIZE, (void*)(((char*)encryptedBlocksBuffer) + (block * BLOCK_SIZE)));
        }
      }

      void* decryptedBlocksBuffer = encryptedBlocksBuffer;

      // where new data goes into decrypted buffer
      void* offsetInDecryptedBlocksBuffer = (void*)(((char*)decryptedBlocksBuffer) + (offset - BLOCK_SIZE * firstBlock));

      // copy new data in decrypted buffer
      memcpy(offsetInDecryptedBlocksBuffer, aBuffer, aLength);

      // encrypt back blocks
      for (size_t block = 0; block < (lastBlock - firstBlock); block++) {
        encrypt(BLOCK_SIZE, (void*)(((char*)decryptedBlocksBuffer) + (block * BLOCK_SIZE)));
      }
      void* reEncryptedBlocksBuffer = decryptedBlocksBuffer;

      // aIoStatus will report more write than requested, problem???
      NTSTATUS realStatus = gOriginalNtWriteFile(aFileHandle, aEvent, aApc, aApcCtx, aIoStatus, reEncryptedBlocksBuffer, writeSpan, &encryptedOffset, aKey);
      if (NT_SUCCESS(realStatus)) {
        // rewrite the aIoStatus values with what the application expected
        aIoStatus->Status = encryptedIoStatus.Status;
        aIoStatus->Information = aLength; // YES LIE.
      }

      // printf_stderr("%s: %s aLength=%lu writeSpan=%zu aIoStatus = { .Status = %08lx, .Information=%lld } realStatus=%08lx ; encryptedIoStatus = { .Status = %08lx, .Information=%lld } encryptedBlocksStatus=%08lx\n", "NtWriteFile READ SUCCESS", filename, aLength, writeSpan, aIoStatus->Status, aIoStatus->Information, realStatus, encryptedIoStatus.Status, encryptedIoStatus.Information, encryptedBlocksStatus);

      free(encryptedBlocksBuffer);
      return realStatus;
  } else {
    return gOriginalNtWriteFile(aFileHandle, aEvent, aApc, aApcCtx, aIoStatus, aBuffer, aLength, aOffset, aKey);
  }
}

// Interposed NtWriteFileGather function
static NTSTATUS NTAPI InterposedNtWriteFileGather(
    HANDLE aFileHandle, HANDLE aEvent, PIO_APC_ROUTINE aApc, PVOID aApcCtx,
    PIO_STATUS_BLOCK aIoStatus, FILE_SEGMENT_ELEMENT* aSegments, ULONG aLength,
    PLARGE_INTEGER aOffset, PULONG aKey) {
  // Something is badly wrong if this function is undefined
  MOZ_ASSERT(gOriginalNtWriteFileGather);

  // Perform encryption
  if (isFileHandleTracked(aFileHandle)) {
    printf_stderr("%s: %s %p\n", "NtWriteFileGather", NS_ConvertUTF16toUTF8(handlesOfInterest[aFileHandle]).get(), aFileHandle);
  }

  // Execute original function
  return gOriginalNtWriteFileGather(aFileHandle, aEvent, aApc, aApcCtx,
                                    aIoStatus, aSegments, aLength, aOffset,
                                    aKey);
}

}  // namespace

/******************************** IO Cryptoing ********************************/

// Windows DLL interceptor
MOZ_RUNINIT static mozilla::WindowsDllInterceptor sNtDllInterceptor;

namespace mozilla {

void InitCryptoIOInterposer() {
  // Currently we hook the functions not early enough to precede third-party
  // injections.  Until we implement a compatible way e.g. applying a hook
  // in the parent process (bug 1646804), we skip interposing functions under
  // the known condition(s).

  // Bug 1679741: Kingsoft Internet Security calls NtReadFile in their thread
  // simultaneously when we're applying a hook on NtReadFile.
  // Bug 1705042: Symantec applies its own hook on NtReadFile, and ends up
  // overwriting part of ours in an incompatible way.
  if (::GetModuleHandleW(L"kwsui64.dll") || ::GetModuleHandleW(L"ffm64.dll")) {
    return;
  }

  // Don't crypto twice... as this function may only be invoked on the main
  // thread when no other threads are running, it safe to allow multiple calls
  // to InitCryptoIOInterposer() without complaining (ie. failing assertions).
  if (sIOCryptoed) {
    return;
  }
  sIOCryptoed = true;

  // Initialize dll interceptor and add hooks
  sNtDllInterceptor.Init("ntdll.dll");
  gOriginalNtCreateFile.Set(sNtDllInterceptor, "NtCreateFile",
                            &InterposedNtCreateFile);
  gOriginalNtOpenFile.Set(sNtDllInterceptor, "NtOpenFile",
                            &InterposedNtOpenFile);
  gOriginalNtClose.Set(sNtDllInterceptor, "NtClose",
                            &InterposedNtClose);
  gOriginalNtReadFile.Set(sNtDllInterceptor, "NtReadFile",
                          &InterposedNtReadFile);
  gOriginalNtReadFileScatter.Set(sNtDllInterceptor, "NtReadFileScatter",
                                 &InterposedNtReadFileScatter);
  gOriginalNtWriteFile.Set(sNtDllInterceptor, "NtWriteFile",
                           &InterposedNtWriteFile);
  gOriginalNtWriteFileGather.Set(sNtDllInterceptor, "NtWriteFileGather",
                                 &InterposedNtWriteFileGather);
}

void ClearCryptoIOInterposer() {
  MOZ_ASSERT(false, "Never called! See bug 1647107");
  if (sIOCryptoed) {
    // Destroy the DLL interceptor
    sIOCryptoed = false;
    sNtDllInterceptor.Clear();
  }
}

}  // namespace mozilla
