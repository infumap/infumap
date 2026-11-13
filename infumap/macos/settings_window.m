// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

#import "settings_window.h"
#include <dispatch/dispatch.h>
#include <string.h>

extern char *infumap_settings_request(const char *settings, const char *request);
extern void infumap_settings_free(char *response);

@interface InfumapSettingsView : NSView
@end
@implementation InfumapSettingsView
- (BOOL)isFlipped { return YES; }
@end

static NSTextField *SettingsLabel(NSString *text, NSRect frame, NSView *parent) {
  NSTextField *label = [NSTextField wrappingLabelWithString:text];
  label.frame = frame;
  [parent addSubview:label];
  return label;
}

static NSButton *SettingsButton(NSString *title, SEL action, id target, NSRect frame, NSView *parent) {
  NSButton *button = [NSButton buttonWithTitle:title target:target action:action];
  button.frame = frame;
  [parent addSubview:button];
  return button;
}

static void SettingsRequest(NSString *settings, NSDictionary *request, void (^completion)(NSDictionary *, NSString *)) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:request options:0 error:&error];
  if (!data) { completion(nil, @"Could not encode settings."); return; }
  NSString *input = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      char *response = infumap_settings_request(settings.UTF8String, input.UTF8String);
      NSData *output = response ? [NSData dataWithBytes:response length:strlen(response)] : nil;
      infumap_settings_free(response);
      NSDictionary *result = output ? [NSJSONSerialization JSONObjectWithData:output options:NSJSONReadingMutableContainers error:NULL] : nil;
      NSDictionary *value = [result[@"ok"] boolValue] ? result[@"value"] : nil;
      NSString *message = value ? nil : (result[@"error"] ?: @"Could not process settings.");
      dispatch_async(dispatch_get_main_queue(), ^{ completion(value, message); });
    }
  });
}

@interface InfumapSettingsWindow () <NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate, NSWindowDelegate>
@property(nonatomic, copy) NSString *settings;
// NSWindowController already declares a readonly owner property.
@property(nonatomic, weak) id<InfumapSettingsDelegate> settingsDelegate;
@property(nonatomic, strong) NSMutableDictionary *snapshot;
@property(nonatomic, strong) NSMutableArray<NSMutableDictionary *> *providers;
// A getter starting with new would acquire ARC factory-method ownership semantics.
@property(nonatomic, strong) NSHashTable<NSMutableDictionary *> *unsavedProviders;
@property(nonatomic, strong) NSTableView *sidebar;
@property(nonatomic, strong) NSTableView *providerList;
@property(nonatomic, strong) NSView *serverPage;
@property(nonatomic, strong) NSView *providersPage;
@property(nonatomic, strong) NSTextField *address;
@property(nonatomic, strong) NSTextField *port;
@property(nonatomic, strong) NSTextField *browserURL;
@property(nonatomic, strong) NSTextField *addressNote;
@property(nonatomic, strong) NSTextField *portNote;
@property(nonatomic, strong) NSTextField *providersNote;
@property(nonatomic, strong) NSTextField *providerID;
@property(nonatomic, strong) NSPopUpButton *adapter;
@property(nonatomic, strong) NSTextField *url;
@property(nonatomic, strong) NSSecureTextField *secret;
@property(nonatomic, strong) NSTextField *revealedSecret;
@property(nonatomic, strong) NSButton *reveal;
@property(nonatomic, strong) NSButton *discovery;
@property(nonatomic, strong) NSTextField *model;
@property(nonatomic, strong) NSTextField *efforts;
@property(nonatomic, strong) NSButton *add;
@property(nonatomic, strong) NSButton *remove;
@property(nonatomic, strong) NSButton *check;
@property(nonatomic, strong) NSTextField *checkResult;
@property(nonatomic, strong) NSTextField *message;
@property(nonatomic, strong) NSTextField *filePath;
@property(nonatomic, strong) NSTextField *serverStatus;
@property(nonatomic, strong) NSButton *saveButton;
@property(nonatomic, strong) NSButton *reloadButton;
@property(nonatomic, readwrite) BOOL saving;
@property(nonatomic) BOOL loading;
@property(nonatomic) BOOL checking;
@property(nonatomic) BOOL filling;
@property(nonatomic) BOOL waitingForRestart;
@property(nonatomic) NSInteger selectedProvider;
@property(nonatomic) NSUInteger checkVersion;
@end

@implementation InfumapSettingsWindow

- (NSTextField *)field:(NSRect)frame parent:(NSView *)parent {
  NSTextField *field = [[NSTextField alloc] initWithFrame:frame];
  field.delegate = self;
  [parent addSubview:field];
  return field;
}

- (NSTableView *)list:(NSRect)frame parent:(NSView *)parent {
  NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:frame];
  scroll.hasVerticalScroller = YES;
  scroll.borderType = NSBezelBorder;
  NSTableView *table = [[NSTableView alloc] initWithFrame:scroll.bounds];
  NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"name"];
  column.width = frame.size.width - 4;
  [table addTableColumn:column];
  table.headerView = nil;
  // Use AppKit's row metrics instead of a fixed height unrelated to the font.
  table.style = NSTableViewStylePlain;
  table.rowSizeStyle = NSTableViewRowSizeStyleMedium;
  table.dataSource = self;
  table.delegate = self;
  scroll.documentView = table;
  [parent addSubview:scroll];
  return table;
}

- (instancetype)initWithSettings:(NSString *)settings delegate:(id<InfumapSettingsDelegate>)delegate {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 940, 700)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
    backing:NSBackingStoreBuffered defer:NO];
  self = [super initWithWindow:window];
  if (!self) return nil;
  self.settings = settings;
  self.settingsDelegate = delegate;
  self.selectedProvider = -1;
  self.providers = [NSMutableArray array];
  self.unsavedProviders = [NSHashTable hashTableWithOptions:NSPointerFunctionsObjectPointerPersonality | NSPointerFunctionsStrongMemory];
  window.title = @"Infumap Settings";
  window.releasedWhenClosed = NO;
  window.delegate = self;
  [window center];
  NSView *root = [[InfumapSettingsView alloc] initWithFrame:NSMakeRect(0, 0, 940, 700)];
  window.contentView = root;
  self.sidebar = [self list:NSMakeRect(14, 20, 160, 590) parent:root];
  self.serverPage = [[InfumapSettingsView alloc] initWithFrame:NSMakeRect(195, 20, 725, 545)];
  self.providersPage = [[InfumapSettingsView alloc] initWithFrame:self.serverPage.frame];
  [root addSubview:self.serverPage];
  [root addSubview:self.providersPage];
  self.providersPage.hidden = YES;

  SettingsLabel(@"Server", NSMakeRect(0, 0, 500, 25), self.serverPage).font = [NSFont boldSystemFontOfSize:18];
  SettingsLabel(@"Listen address", NSMakeRect(0, 55, 400, 20), self.serverPage);
  self.address = [self field:NSMakeRect(0, 80, 450, 25) parent:self.serverPage];
  self.addressNote = SettingsLabel(@"127.0.0.1 allows connections only from this Mac. Use 0.0.0.0 to listen on all IPv4 interfaces.", NSMakeRect(0, 115, 620, 45), self.serverPage);
  SettingsLabel(@"Port", NSMakeRect(0, 180, 400, 20), self.serverPage);
  self.port = [self field:NSMakeRect(0, 205, 140, 25) parent:self.serverPage];
  self.portNote = SettingsLabel(@"0 chooses an available port when the server starts.", NSMakeRect(0, 240, 620, 40), self.serverPage);
  self.browserURL = SettingsLabel(@"", NSMakeRect(0, 310, 650, 50), self.serverPage);

  SettingsLabel(@"Chat Providers", NSMakeRect(0, 0, 500, 25), self.providersPage).font = [NSFont boldSystemFontOfSize:18];
  self.providersNote = SettingsLabel(@"", NSMakeRect(0, 30, 720, 35), self.providersPage);
  self.providerList = [self list:NSMakeRect(0, 70, 180, 370) parent:self.providersPage];
  self.add = SettingsButton(@"Add", @selector(addProvider:), self, NSMakeRect(0, 448, 80, 30), self.providersPage);
  self.remove = SettingsButton(@"Remove", @selector(removeProvider:), self, NSMakeRect(85, 448, 95, 30), self.providersPage);

  NSView *form = [[InfumapSettingsView alloc] initWithFrame:NSMakeRect(200, 70, 520, 475)];
  [self.providersPage addSubview:form];
  SettingsLabel(@"Provider ID", NSMakeRect(0, 0, 500, 20), form);
  self.providerID = [self field:NSMakeRect(0, 22, 505, 25) parent:form];
  self.providerID.toolTip = @"Existing IDs stay fixed because saved query profiles refer to them.";
  SettingsLabel(@"Type", NSMakeRect(0, 57, 500, 20), form);
  self.adapter = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(0, 78, 505, 28) pullsDown:NO];
  [self.adapter addItemsWithTitles:@[@"OpenAI-compatible", @"OpenRouter", @"llama.cpp"]];
  self.adapter.target = self;
  self.adapter.action = @selector(adapterChanged:);
  [form addSubview:self.adapter];
  SettingsLabel(@"API base URL", NSMakeRect(0, 115, 500, 20), form);
  self.url = [self field:NSMakeRect(0, 137, 505, 25) parent:form];
  SettingsLabel(@"API key (optional)", NSMakeRect(0, 172, 500, 20), form);
  self.secret = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 194, 415, 25)];
  self.secret.delegate = self;
  [form addSubview:self.secret];
  self.revealedSecret = [self field:self.secret.frame parent:form];
  self.revealedSecret.hidden = YES;
  self.reveal = SettingsButton(@"Show", @selector(revealSecret:), self, NSMakeRect(425, 192, 80, 28), form);
  self.discovery = [NSButton checkboxWithTitle:@"Discover models" target:self action:@selector(discoveryChanged:)];
  self.discovery.frame = NSMakeRect(0, 231, 505, 24);
  [form addSubview:self.discovery];
  SettingsLabel(@"Model ID (when discovery is off)", NSMakeRect(0, 266, 500, 20), form);
  self.model = [self field:NSMakeRect(0, 288, 505, 25) parent:form];
  self.model.placeholderString = @"default";
  SettingsLabel(@"Reasoning efforts (optional, comma-separated)", NSMakeRect(0, 323, 500, 20), form);
  self.efforts = [self field:NSMakeRect(0, 345, 505, 25) parent:form];
  self.efforts.placeholderString = @"none, minimal, low, medium, high, xhigh, max";
  self.check = SettingsButton(@"Check Connection", @selector(checkConnection:), self, NSMakeRect(0, 382, 160, 30), form);
  self.checkResult = SettingsLabel(@"", NSMakeRect(0, 420, 505, 55), form);
  self.checkResult.font = [NSFont systemFontOfSize:11];

  self.message = SettingsLabel(@"", NSMakeRect(195, 575, 725, 45), root);
  self.filePath = SettingsLabel(@"", NSMakeRect(195, 620, 725, 22), root);
  self.filePath.font = [NSFont systemFontOfSize:11];
  self.filePath.selectable = YES;
  self.filePath.lineBreakMode = NSLineBreakByTruncatingMiddle;
  self.serverStatus = SettingsLabel(@"", NSMakeRect(195, 650, 290, 35), root);
  self.serverStatus.font = [NSFont systemFontOfSize:11];
  self.reloadButton = SettingsButton(@"Reload", @selector(reload:), self, NSMakeRect(14, 650, 140, 30), root);
  SettingsButton(@"Show Logs", @selector(showLogs:), self, NSMakeRect(490, 650, 100, 30), root);
  NSButton *cancel = SettingsButton(@"Cancel", @selector(cancel:), self, NSMakeRect(670, 650, 100, 30), root);
  cancel.keyEquivalent = @"\033";
  self.saveButton = SettingsButton(@"Save", @selector(save:), self, NSMakeRect(780, 650, 145, 30), root);
  self.saveButton.keyEquivalent = @"\r";
  [self.sidebar reloadData];
  [self.sidebar selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
  [self updateEnabled];
  return self;
}

- (void)open {
  BOOL visible = self.window.visible;
  if (!visible) {
    self.secret.hidden = NO;
    self.revealedSecret.hidden = YES;
    self.reveal.title = @"Show";
    [self reload:nil];
  }
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 140000
  if (@available(macOS 14.0, *)) [NSApp activate];
  else
#endif
  {
    // macOS 11–13 require this activation API for accessory-app windows.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
  }
  [self showWindow:nil];
  [self.window makeKeyAndOrderFront:nil];
}

- (void)reload:(id)sender {
  (void)sender;
  if (self.loading || self.saving || self.waitingForRestart) return;
  self.loading = YES;
  self.checkVersion++;
  self.message.stringValue = @"Loading settings…";
  [self updateEnabled];
  SettingsRequest(self.settings, @{@"operation":@"load"}, ^(NSDictionary *value, NSString *error) {
    self.loading = NO;
    if (error) {
      self.snapshot = nil;
      self.message.textColor = NSColor.systemRedColor;
      self.message.stringValue = error;
      [self updateEnabled];
      return;
    }
    [self applySnapshot:value];
    self.message.textColor = NSColor.labelColor;
    self.message.stringValue = [value[@"env_only"] boolValue] ? @"Settings are supplied entirely by environment variables." : @"";
  });
}

- (void)applySnapshot:(NSDictionary *)snapshot {
  self.filling = YES;
  self.snapshot = [snapshot mutableCopy];
  self.providers = [NSMutableArray array];
  [self.unsavedProviders removeAllObjects];
  for (NSDictionary *provider in snapshot[@"providers"]) {
    [self.providers addObject:[provider mutableCopy]];
  }
  self.address.stringValue = snapshot[@"address"];
  self.port.stringValue = snapshot[@"port"];
  self.filePath.stringValue = [snapshot[@"env_only"] boolValue] ? @"Environment configuration; no settings file is used." : snapshot[@"path"];
  self.filePath.toolTip = snapshot[@"path"];
  self.addressNote.stringValue = [snapshot[@"address_overridden"] boolValue] ? @"Controlled by INFUMAP_ADDRESS (or environment-only configuration)." : @"127.0.0.1 allows connections only from this Mac. Use 0.0.0.0 to listen on all IPv4 interfaces.";
  self.portNote.stringValue = [snapshot[@"port_overridden"] boolValue] ? @"Controlled by INFUMAP_PORT (or environment-only configuration)." : @"0 chooses an available port when the server starts.";
  self.providersNote.stringValue = [snapshot[@"providers_overridden"] boolValue] ? @"Providers are controlled by environment variables and cannot be edited here." : @"Existing provider IDs stay fixed so saved query profiles keep working.";
  self.selectedProvider = -1;
  [self.providerList reloadData];
  if (self.providers.count) [self.providerList selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
  self.selectedProvider = self.providers.count ? 0 : -1;
  self.filling = NO;
  [self fillProvider];
  [self updateURL];
  [self updateEnabled];
}

- (void)updateEnabled {
  BOOL ready = self.snapshot && !self.loading && !self.saving && !self.waitingForRestart;
  BOOL editable = ready && ![self.snapshot[@"env_only"] boolValue];
  BOOL providerEditable = editable && ![self.snapshot[@"providers_overridden"] boolValue];
  BOOL selected = self.selectedProvider >= 0 && self.selectedProvider < (NSInteger)self.providers.count;
  self.address.enabled = editable && ![self.snapshot[@"address_overridden"] boolValue];
  self.port.enabled = editable && ![self.snapshot[@"port_overridden"] boolValue];
  self.add.enabled = providerEditable;
  self.remove.enabled = providerEditable && selected;
  self.providerID.enabled = providerEditable && selected && [self.unsavedProviders containsObject:self.providers[self.selectedProvider]];
  self.adapter.enabled = providerEditable && selected;
  self.url.enabled = providerEditable && selected;
  self.secret.enabled = providerEditable && selected;
  self.revealedSecret.enabled = self.secret.enabled;
  self.reveal.enabled = ready && selected;
  BOOL router = self.adapter.indexOfSelectedItem == 1;
  self.discovery.enabled = providerEditable && selected && !router;
  self.model.enabled = providerEditable && selected && self.discovery.state == NSControlStateValueOff;
  self.efforts.enabled = providerEditable && selected;
  self.check.enabled = ready && selected && !self.checking;
  self.reloadButton.enabled = !self.loading && !self.saving && !self.waitingForRestart;
  BOOL anyEditable = ![self.snapshot[@"address_overridden"] boolValue] || ![self.snapshot[@"port_overridden"] boolValue] || ![self.snapshot[@"providers_overridden"] boolValue];
  self.saveButton.enabled = editable && anyEditable && ![self.settingsDelegate settingsServerStopping];
  self.saveButton.title = [self.settingsDelegate settingsServerRunning] ? @"Save and Restart" : @"Save";
}

- (void)updateURL {
  NSString *host = [self.address.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if ([host isEqualToString:@"0.0.0.0"]) host = @"127.0.0.1";
  if ([host isEqualToString:@"::"] || [host isEqualToString:@"[::]"]) host = @"::1";
  if ([host containsString:@":"] && ![host hasPrefix:@"["]) host = [NSString stringWithFormat:@"[%@]", host];
  self.browserURL.stringValue = self.port.stringValue.integerValue == 0 ? @"Browser URL: assigned when the server starts." : [NSString stringWithFormat:@"Browser URL: http://%@:%@/", host, self.port.stringValue];
}

- (void)commitProvider {
  if (self.filling || self.selectedProvider < 0 || self.selectedProvider >= (NSInteger)self.providers.count || [self.snapshot[@"providers_overridden"] boolValue]) return;
  NSMutableDictionary *provider = self.providers[self.selectedProvider];
  provider[@"id"] = [self.providerID.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  provider[@"adapter"] = @[@"openai", @"openrouter", @"llama_cpp"][MAX(0, self.adapter.indexOfSelectedItem)];
  provider[@"url"] = [self.url.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSString *key = self.secret.hidden ? self.revealedSecret.stringValue : self.secret.stringValue;
  if (key.length) provider[@"api_key"] = key; else [provider removeObjectForKey:@"api_key"];
  // Boxing a C comparison with @(...) produces an integer NSNumber, serialized
  // as 0/1. Rust expects a JSON boolean for both connection checks and saves.
  provider[@"discover_models"] = self.discovery.state == NSControlStateValueOn ? @YES : @NO;
  if (self.discovery.state == NSControlStateValueOff && self.model.stringValue.length) provider[@"model_name"] = self.model.stringValue;
  else [provider removeObjectForKey:@"model_name"];
  NSMutableArray *efforts = [NSMutableArray array];
  for (NSString *effort in [self.efforts.stringValue componentsSeparatedByString:@","]) {
    NSString *trimmed = [[effort stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
    if (trimmed.length) [efforts addObject:trimmed];
  }
  provider[@"reasoning_efforts"] = efforts;
}

- (void)fillProvider {
  self.filling = YES;
  NSDictionary *provider = self.selectedProvider >= 0 && self.selectedProvider < (NSInteger)self.providers.count ? self.providers[self.selectedProvider] : nil;
  self.providerID.stringValue = provider[@"id"] ?: @"";
  NSInteger adapter = [@[@"openai", @"openrouter", @"llama_cpp"] indexOfObject:provider[@"adapter"] ?: @"openai"];
  [self.adapter selectItemAtIndex:adapter == (NSInteger)NSNotFound ? 0 : adapter];
  self.url.stringValue = provider[@"url"] ?: @"";
  self.secret.stringValue = provider[@"api_key"] ?: @"";
  self.revealedSecret.stringValue = self.secret.stringValue;
  self.secret.hidden = NO;
  self.revealedSecret.hidden = YES;
  self.reveal.title = @"Show";
  self.discovery.state = [provider[@"discover_models"] boolValue] || adapter == 1 ? NSControlStateValueOn : NSControlStateValueOff;
  self.model.stringValue = provider[@"model_name"] ?: @"";
  self.efforts.stringValue = [provider[@"reasoning_efforts"] componentsJoinedByString:@", "] ?: @"";
  self.checkResult.stringValue = provider ? @"Discovery checks the model list. With discovery off, checking sends a short chat request; provider charges may apply." : @"Add a provider to configure chat access.";
  self.checkResult.textColor = NSColor.secondaryLabelColor;
  self.checkResult.toolTip = nil;
  self.filling = NO;
  [self updateEnabled];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
  return tableView == self.sidebar ? 2 : (NSInteger)self.providers.count;
}

- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
  NSString *name = tableView == self.sidebar ? @[@"Server", @"Chat Providers"][row] : self.providers[row][@"id"];
  NSTableCellView *cell = (NSTableCellView *)[tableView makeViewWithIdentifier:column.identifier owner:self];
  if (!cell) {
    cell = [[NSTableCellView alloc] initWithFrame:NSZeroRect];
    cell.identifier = column.identifier;
    NSTextField *label = [NSTextField labelWithString:@""];
    label.font = [NSFont systemFontOfSize:[NSFont systemFontSizeForControlSize:NSControlSizeRegular]];
    label.lineBreakMode = NSLineBreakByTruncatingTail;
    label.maximumNumberOfLines = 1;
    label.translatesAutoresizingMaskIntoConstraints = NO;
    [cell addSubview:label];
    cell.textField = label;
    [NSLayoutConstraint activateConstraints:@[
      [label.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:4],
      [label.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-4],
      [label.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor],
    ]];
  }
  cell.textField.stringValue = name.length ? name : @"New provider";
  return cell;
}

- (BOOL)tableView:(NSTableView *)tableView shouldSelectRow:(NSInteger)row {
  (void)tableView; (void)row;
  return !self.loading && !self.saving && !self.waitingForRestart;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
  if (notification.object == self.sidebar) {
    self.serverPage.hidden = self.sidebar.selectedRow == 1;
    self.providersPage.hidden = !self.serverPage.hidden;
    return;
  }
  if (self.filling) return;
  [self commitProvider];
  self.selectedProvider = self.providerList.selectedRow;
  self.checkVersion++;
  [self fillProvider];
}

- (void)controlTextDidChange:(NSNotification *)notification {
  if (self.filling) return;
  if (notification.object == self.address || notification.object == self.port) { [self updateURL]; return; }
  if (self.selectedProvider < 0) return;
  self.checkVersion++;
  [self commitProvider];
  NSTableCellView *cell = (NSTableCellView *)[self.providerList viewAtColumn:0 row:self.selectedProvider makeIfNecessary:NO];
  cell.textField.stringValue = self.providerID.stringValue.length ? self.providerID.stringValue : @"New provider";
  self.checkResult.stringValue = @"Provider changed; check the connection again when ready.";
  self.checkResult.toolTip = nil;
}

- (void)addProvider:(id)sender {
  (void)sender;
  [self commitProvider];
  NSMutableSet *ids = [NSMutableSet set];
  for (NSDictionary *provider in self.providers) [ids addObject:provider[@"id"]];
  NSUInteger index = 1;
  while ([ids containsObject:[NSString stringWithFormat:@"provider-%lu", (unsigned long)index]]) index++;
  [self.providers addObject:[@{@"id":[NSString stringWithFormat:@"provider-%lu", (unsigned long)index], @"url":@"http://127.0.0.1:8080/v1", @"adapter":@"openai", @"discover_models":@YES, @"reasoning_efforts":@[]} mutableCopy]];
  [self.unsavedProviders addObject:self.providers.lastObject];
  self.filling = YES;
  [self.providerList reloadData];
  [self.providerList selectRowIndexes:[NSIndexSet indexSetWithIndex:self.providers.count - 1] byExtendingSelection:NO];
  self.selectedProvider = (NSInteger)self.providers.count - 1;
  self.filling = NO;
  self.checkVersion++;
  [self fillProvider];
}

- (void)removeProvider:(id)sender {
  (void)sender;
  if (self.selectedProvider < 0) return;
  [self.unsavedProviders removeObject:self.providers[self.selectedProvider]];
  [self.providers removeObjectAtIndex:self.selectedProvider];
  self.selectedProvider = -1;
  self.filling = YES;
  [self.providerList reloadData];
  if (self.providers.count) [self.providerList selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
  else [self.providerList deselectAll:nil];
  self.selectedProvider = self.providers.count ? 0 : -1;
  self.filling = NO;
  self.checkVersion++;
  [self fillProvider];
  self.message.textColor = NSColor.labelColor;
  self.message.stringValue = @"Provider removed from these settings. Saved profiles using its ID will need another provider after saving.";
}

- (void)adapterChanged:(id)sender {
  (void)sender;
  if (self.adapter.indexOfSelectedItem == 1) {
    self.discovery.state = NSControlStateValueOn;
    if ([self.url.stringValue isEqualToString:@"http://127.0.0.1:8080/v1"]) self.url.stringValue = @"https://openrouter.ai/api/v1";
  }
  [self discoveryChanged:nil];
}

- (void)discoveryChanged:(id)sender {
  (void)sender;
  self.checkVersion++;
  [self commitProvider];
  self.checkResult.stringValue = @"Discovery checks the model list. With discovery off, checking sends a short chat request; provider charges may apply.";
  [self updateEnabled];
}

- (void)revealSecret:(id)sender {
  (void)sender;
  [self.window makeFirstResponder:nil];
  if (self.secret.hidden) self.secret.stringValue = self.revealedSecret.stringValue;
  else self.revealedSecret.stringValue = self.secret.stringValue;
  self.secret.hidden = !self.secret.hidden;
  self.revealedSecret.hidden = !self.secret.hidden;
  self.reveal.title = self.secret.hidden ? @"Hide" : @"Show";
}

- (void)checkConnection:(id)sender {
  (void)sender;
  [self.window makeFirstResponder:nil];
  [self commitProvider];
  if (self.selectedProvider < 0 || self.checking) return;
  NSUInteger version = ++self.checkVersion;
  self.checking = YES;
  self.checkResult.textColor = NSColor.secondaryLabelColor;
  self.checkResult.stringValue = @"Checking connection…";
  [self updateEnabled];
  SettingsRequest(self.settings, @{@"operation":@"check", @"provider":self.providers[self.selectedProvider]}, ^(NSDictionary *value, NSString *error) {
    self.checking = NO;
    if (version == self.checkVersion) {
      self.checkResult.textColor = error ? NSColor.systemRedColor : NSColor.labelColor;
      self.checkResult.stringValue = error ?: value[@"message"];
      NSArray *models = value[@"models"];
      self.checkResult.toolTip = models ? [[models subarrayWithRange:NSMakeRange(0, MIN(models.count, 50))] componentsJoinedByString:@"\n"] : nil;
    }
    [self updateEnabled];
  });
}

- (void)save:(id)sender {
  (void)sender;
  if (!self.saveButton.enabled) return;
  [self.window makeFirstResponder:nil];
  [self commitProvider];
  BOOL restart = [self.settingsDelegate settingsServerRunning];
  self.saving = YES;
  self.checkVersion++;
  self.message.textColor = NSColor.labelColor;
  self.message.stringValue = @"Saving settings…";
  [self updateEnabled];
  [self.settingsDelegate settingsSaveStarted];
  SettingsRequest(self.settings, @{@"operation":@"save", @"revision":self.snapshot[@"revision"], @"address":self.address.stringValue,
    @"port":self.port.stringValue, @"providers":self.providers}, ^(NSDictionary *value, NSString *error) {
    self.saving = NO;
    if (error) {
      self.message.textColor = NSColor.systemRedColor;
      self.message.stringValue = error;
      [self updateEnabled];
      [self.settingsDelegate settingsSaveFinished];
      return;
    }
    [self applySnapshot:value];
    self.waitingForRestart = restart;
    self.message.textColor = NSColor.labelColor;
    self.message.stringValue = restart ? @"Settings saved. Waiting for the server to restart…" : @"Settings saved.";
    [self updateEnabled];
    [self.settingsDelegate settingsSavedWithRestart:restart];
    [self.settingsDelegate settingsSaveFinished];
  });
}

- (void)serverStateChanged:(NSString *)status busy:(BOOL)busy {
  self.serverStatus.stringValue = [@"Server: " stringByAppendingString:status];
  if (self.waitingForRestart && !busy) {
    self.waitingForRestart = NO;
    self.message.stringValue = [@"Settings saved. Server: " stringByAppendingString:status];
    self.message.textColor = [self.settingsDelegate settingsServerRunning] ? NSColor.labelColor : NSColor.systemRedColor;
  }
  [self updateEnabled];
}

- (void)showLogs:(id)sender { (void)sender; [self.settingsDelegate settingsShowLogs]; }
- (void)cancel:(id)sender { (void)sender; if (!self.saving) [self close]; }
- (BOOL)windowShouldClose:(NSWindow *)sender { (void)sender; return !self.saving; }
@end
