// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later
#import <AppKit/AppKit.h>

@protocol InfumapSettingsDelegate <NSObject>
- (BOOL)settingsServerRunning;
- (BOOL)settingsServerStopping;
- (void)settingsSavedWithRestart:(BOOL)restart;
- (void)settingsSaveStarted;
- (void)settingsSaveFinished;
- (void)settingsShowLogs;
@end

@interface InfumapSettingsWindow : NSWindowController
@property(nonatomic, readonly) BOOL saving;
- (instancetype)initWithSettings:(NSString *)settings delegate:(id<InfumapSettingsDelegate>)delegate;
- (void)open;
- (void)serverStateChanged:(NSString *)status busy:(BOOL)busy;
@end
