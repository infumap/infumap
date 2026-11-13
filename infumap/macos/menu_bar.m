// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include "icon.h"

@interface InfumapMenuBar : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *executable;
@property(nonatomic, copy) NSString *settings;
@property(nonatomic, strong) NSURL *logURL;
@property(nonatomic, strong) NSFileHandle *logFile;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSMenuItem *statusMenuItem;
@property(nonatomic, strong) NSMenuItem *startMenuItem;
@property(nonatomic, strong) NSMenuItem *stopMenuItem;
@property(nonatomic, strong) NSMenuItem *openMenuItem;
@property(nonatomic, strong) NSTask *server;
@property(nonatomic, strong) NSPipe *shutdownPipe;
@property(nonatomic, strong) NSPipe *readyPipe;
@property(nonatomic, strong) NSURL *serverURL;
@property(nonatomic) BOOL stopping;
@property(nonatomic) BOOL terminating;
@property(nonatomic, strong) dispatch_source_t interruptSource;
@property(nonatomic, strong) dispatch_source_t terminateSource;
- (void)startServer:(id)sender;
- (void)stopServer:(id)sender;
- (void)openBrowser:(id)sender;
- (void)showLogs:(id)sender;
- (void)quit:(id)sender;
@end

@implementation InfumapMenuBar

- (void)record:(NSString *)message {
  NSData *data = [[NSString stringWithFormat:@"\n%@ %@\n", NSDate.date, message] dataUsingEncoding:NSUTF8StringEncoding];
  [self.logFile writeData:data];
}

- (void)updateMenu:(NSString *)status {
  self.statusMenuItem.title = status;
  self.statusItem.button.toolTip = [@"Infumap — " stringByAppendingString:status];
  self.startMenuItem.enabled = self.server == nil && !self.terminating;
  self.stopMenuItem.enabled = self.server != nil && !self.stopping;
  self.openMenuItem.enabled = self.serverURL != nil && !self.stopping;
}

- (NSMenuItem *)item:(NSString *)title action:(SEL)action menu:(NSMenu *)menu {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:@""];
  item.target = self;
  [menu addItem:item];
  return item;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
  NSImage *image = [[NSImage alloc] initWithData:[NSData dataWithBytes:infumap_icon length:sizeof(infumap_icon)]];
  if (image) {
    image.size = NSMakeSize(18, 18);
    self.statusItem.button.image = image;
  } else {
    self.statusItem.button.title = @"Infumap";
  }
  self.statusItem.button.accessibilityLabel = @"Infumap";
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Infumap"];
  menu.autoenablesItems = NO;
  self.statusMenuItem = [self item:@"Starting…" action:NULL menu:menu];
  self.statusMenuItem.enabled = NO;
  [menu addItem:NSMenuItem.separatorItem];
  self.startMenuItem = [self item:@"Start Web Server" action:@selector(startServer:) menu:menu];
  self.stopMenuItem = [self item:@"Stop Web Server" action:@selector(stopServer:) menu:menu];
  [menu addItem:NSMenuItem.separatorItem];
  self.openMenuItem = [self item:@"Open Infumap in Browser" action:@selector(openBrowser:) menu:menu];
  [self item:@"Show Logs" action:@selector(showLogs:) menu:menu];
  [menu addItem:NSMenuItem.separatorItem];
  [self item:@"Quit Infumap" action:@selector(quit:) menu:menu];
  self.statusItem.menu = menu;

  // Route terminal interrupts through the same asynchronous shutdown as Quit.
  // The child's private stdin pipe also closes if this process is killed.
  signal(SIGINT, SIG_IGN);
  signal(SIGTERM, SIG_IGN);
  __weak InfumapMenuBar *weakSelf = self;
  self.interruptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
  self.terminateSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.interruptSource, ^{ [weakSelf quit:nil]; });
  dispatch_source_set_event_handler(self.terminateSource, ^{ [weakSelf quit:nil]; });
  dispatch_resume(self.interruptSource);
  dispatch_resume(self.terminateSource);
  [self startServer:nil];
}

- (void)startServer:(id)sender {
  (void)sender;
  if (self.server || self.terminating) return;
  self.stopping = NO;
  self.serverURL = nil;
  [self record:@"Starting Infumap web server."];
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:self.executable];
  NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithObject:@"--server"];
  if (self.settings) [arguments addObjectsFromArray:@[@"--settings", self.settings]];
  task.arguments = arguments;
  self.shutdownPipe = NSPipe.pipe;
  self.readyPipe = NSPipe.pipe;
  task.standardInput = self.shutdownPipe;
  task.standardOutput = self.readyPipe;
  task.standardError = self.logFile;
  self.server = task;
  [self updateMenu:@"Starting…"];

  __weak InfumapMenuBar *weakSelf = self;
  NSMutableData *pending = [NSMutableData data];
  self.readyPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (data.length == 0) {
      handle.readabilityHandler = nil;
      return;
    }
    // Readiness may arrive in chunks; preserve other stdout in the log.
    dispatch_async(dispatch_get_main_queue(), ^{
      InfumapMenuBar *app = weakSelf;
      if (!app || app.server != task) return;
      [pending appendData:data];
      while (pending.length) {
        const char *bytes = pending.bytes;
        const char *newline = memchr(bytes, '\n', pending.length);
        if (!newline) break;
        NSUInteger length = (NSUInteger)(newline - bytes);
        NSString *line = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
        [pending replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
        if (![line hasPrefix:@"INFUMAP_READY "]) {
          if (line) [app record:line];
          continue;
        }
        NSURL *url = [NSURL URLWithString:[line substringFromIndex:@"INFUMAP_READY ".length]];
        if (!app.stopping && [url.scheme isEqualToString:@"http"] && url.host && url.port) {
          app.serverURL = url;
          [app updateMenu:@"Running"];
          [app record:[@"Listening at " stringByAppendingString:url.absoluteString]];
        }
      }
    });
  };
  task.terminationHandler = ^(NSTask *finished) {
    dispatch_async(dispatch_get_main_queue(), ^{
      InfumapMenuBar *app = weakSelf;
      if (!app || app.server != finished) return;
      BOOL expected = app.stopping;
      app.readyPipe.fileHandleForReading.readabilityHandler = nil;
      [app.readyPipe.fileHandleForReading closeFile];
      [app.shutdownPipe.fileHandleForWriting closeFile];
      app.readyPipe = nil;
      app.shutdownPipe = nil;
      app.server = nil;
      app.serverURL = nil;
      app.stopping = NO;
      [app record:[NSString stringWithFormat:@"Server exited with status %d.", finished.terminationStatus]];
      [app updateMenu:expected && finished.terminationStatus == 0 ? @"Stopped" : @"Server exited — see logs"];
      if (app.terminating) [NSApp replyToApplicationShouldTerminate:YES];
    });
  };
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) {
    task.terminationHandler = nil;
    self.readyPipe.fileHandleForReading.readabilityHandler = nil;
    [self.readyPipe.fileHandleForReading closeFile];
    [self.readyPipe.fileHandleForWriting closeFile];
    [self.shutdownPipe.fileHandleForReading closeFile];
    [self.shutdownPipe.fileHandleForWriting closeFile];
    self.readyPipe = nil;
    self.shutdownPipe = nil;
    self.server = nil;
    [self record:[@"Could not launch server: " stringByAppendingString:error.localizedDescription]];
    [self updateMenu:@"Failed to start — see logs"];
  }
}

- (void)stopServer:(id)sender {
  (void)sender;
  if (!self.server || self.stopping) return;
  self.stopping = YES;
  self.serverURL = nil;
  [self record:@"Stopping server; waiting for maintenance and active requests to finish."];
  [self updateMenu:@"Stopping…"];
  // Closing the pipe requests shutdown without interrupting a data migration.
  [self.shutdownPipe.fileHandleForWriting closeFile];
}

- (void)openBrowser:(id)sender {
  (void)sender;
  if (self.serverURL && ![NSWorkspace.sharedWorkspace openURL:self.serverURL]) {
    [self record:@"Could not open the default browser."];
  }
}

- (void)showLogs:(id)sender {
  (void)sender;
  // Console follows the existing file as the child appends to it.
  NSURL *console = [NSURL fileURLWithPath:@"/System/Applications/Utilities/Console.app"];
  [NSWorkspace.sharedWorkspace openURLs:@[self.logURL] withApplicationAtURL:console
    configuration:NSWorkspaceOpenConfiguration.configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
      (void)app;
      if (error) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self record:[@"Could not open Console: " stringByAppendingString:error.localizedDescription]];
          [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[self.logURL]];
        });
      }
    }];
}

- (void)quit:(id)sender {
  (void)sender;
  [NSApp terminate:nil];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender;
  if (!self.server) return NSTerminateNow;
  self.terminating = YES;
  [self stopServer:nil];
  return NSTerminateLater;
}
@end

int infumap_menu_bar_main(const char *executable, const char *settings) {
  @autoreleasepool {
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
    InfumapMenuBar *delegate = [[InfumapMenuBar alloc] init];
    delegate.executable = [NSString stringWithUTF8String:executable];
    delegate.settings = settings ? [NSString stringWithUTF8String:settings] : nil;
    NSURL *directory = [NSFileManager.defaultManager.homeDirectoryForCurrentUser URLByAppendingPathComponent:@"Library/Logs/Infumap" isDirectory:YES];
    NSError *error = nil;
    BOOL created = [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES
      attributes:@{NSFilePosixPermissions: @0700} error:&error];
    int lock = created ? open([[directory URLByAppendingPathComponent:@"menu.lock"] fileSystemRepresentation], O_CREAT | O_RDWR | O_CLOEXEC, 0600) : -1;
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) {
      NSAlert *alert = [[NSAlert alloc] init];
      alert.messageText = @"Could not start Infumap";
      alert.informativeText = created ? @"Infumap may already be in the menu bar, or its log directory is inaccessible." : error.localizedDescription;
      [alert runModal];
      if (lock >= 0) close(lock);
      return 1;
    }
    delegate.logURL = [directory URLByAppendingPathComponent:@"server.log"];
    int logFD = open(delegate.logURL.fileSystemRepresentation, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0600);
    if (logFD < 0) {
      NSAlert *alert = [[NSAlert alloc] init];
      alert.messageText = @"Could not open the Infumap log file";
      alert.informativeText = delegate.logURL.path;
      [alert runModal];
      close(lock);
      return 1;
    }
    delegate.logFile = [[NSFileHandle alloc] initWithFileDescriptor:logFD closeOnDealloc:YES];
    application.delegate = delegate;
    [application run];
    [delegate.logFile closeFile];
    close(lock);
    return 0;
  }
}
