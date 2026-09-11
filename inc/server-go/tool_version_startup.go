package main

import (
	"fmt"
	"os"
)

func checkToolVersionBeforeLaunch(configuration config) error {
	return checkToolVersionWithPrompt(configuration, toolVersionDialog, toolVersionUpdateDialog)
}

func checkToolVersionWithPrompt(configuration config, toolVersionDialog func(string, bool) (bool, error), updateDialog func(string, string) (bool, error)) error {
	unlock, err := lockToolRecord()
	if err != nil {
		return fmt.Errorf("another version check is active, or system settings are not writable: %w", err)
	}
	defer unlock()
	status := inspectToolVersion(configuration)
	if status.State == "error" || status.State == "unavailable" {
		_, _ = toolVersionDialog("\u65e0\u6cd5\u68c0\u67e5\u672c\u673a\u7248\u672c\uff0c\u7ee7\u7eed\u6253\u5f00\u5f53\u524d\u5de5\u5177\u3002\n"+status.Message+"\n\u53ef\u5728\u8bbe\u7f6e\u4e2d\u7684\u7248\u672c\u7ba1\u7406\u91cd\u65b0\u6307\u5b9a\u76ee\u5f55\u3002", false)
		return nil
	}
	if status.State == "unregistered" {
		yes, e := toolVersionDialog("\u9996\u6b21\u4f7f\u7528\u7248\u672c\u7ba1\u7406\u3002\n\u662f\u5426\u5c06\u5f53\u524d\u76ee\u5f55\u8bb0\u5f55\u4e3a\u672c\u673a\u6700\u65b0\u7248\u672c\u76ee\u5f55\uff1f\n\n\u7248\u672c\uff1a"+status.Current+"\n\u76ee\u5f55\uff1a"+configuration.rootDir+"\n\n\u9009\u5426\u540e\uff0c\u4e5f\u53ef\u5728\u8bbe\u7f6e > \u7248\u672c\u7ba1\u7406\u4e2d\u6307\u5b9a\u5176\u4ed6\u76ee\u5f55\u3002", true)
		if e != nil {
			return e
		}
		if !yes {
			return nil
		}
		return writeToolRecord(toolVersionRecord{Directory: configuration.rootDir, Version: status.Current, HTML: configuration.htmlName})
	}
	if samePath(status.Record.Directory, configuration.rootDir) {
		status.Record.HTML = configuration.htmlName
		return writeToolRecord(status.Record)
	}
	if status.State == "equal" {
		return nil
	}
	source, target, sourceHTML, targetHTML := configuration.rootDir, status.Record.Directory, configuration.htmlName, status.Record.HTML
	heading := "\u5f53\u524d\u526f\u672c\u8f83\u65b0\uff0c\u662f\u5426\u66f4\u65b0\u5230\u7cfb\u7edf\u8bb0\u5f55\u7684\u76ee\u5f55\uff1f"
	fromVersion, toVersion := status.Record.Version, status.Current
	if status.State == "upgrade" {
		source, target, sourceHTML, targetHTML = status.Record.Directory, configuration.rootDir, status.Record.HTML, configuration.htmlName
		heading = "\u5f53\u524d\u526f\u672c\u8f83\u65e7\uff0c\u662f\u5426\u4ece\u7cfb\u7edf\u8bb0\u5f55\u7684\u76ee\u5f55\u5347\u7ea7\uff1f"
		fromVersion, toVersion = status.Current, status.Record.Version
	}
	if fromVersion == "" {
		fromVersion = "\u672a\u5b58\u653e\u5de5\u5177"
		targetHTML = sourceHTML
	}
	message := heading + "\n\n" + fromVersion + " \u2192 " + toVersion + "\n\u6765\u6e90\uff1a" + source + "\n\u66f4\u65b0\u5230\uff1a" + target + "\n\n\u4ec5\u66f4\u65b0\u7a0b\u5e8f\u6587\u4ef6\uff0c\u4fdd\u7559 Wave\u3001\u5bfc\u5165\u9884\u8bbe\u548c\u542f\u52a8\u811a\u672c\u7684\u9879\u76ee\u914d\u7f6e\u3002"
	if updateDialog == nil {
		updateDialog = func(message, history string) (bool, error) { return toolVersionDialog(message, true) }
	}
	yes, err := updateDialog(message, formatToolHistory(toolHistoryBetween(configuration.rootDir, status.Record.Directory, status.Current, status.Record.Version)))
	if err != nil {
		return err
	}
	if !yes {
		return nil
	}
	fmt.Printf("Updating VisualWaveDrom %s -> %s ...\n", fromVersion, toVersion)
	if err = updateToolDirectory(source, target, sourceHTML, targetHTML); err != nil {
		_, _ = toolVersionDialog("\u66f4\u65b0\u672a\u5b8c\u6210\u3002\n"+err.Error()+"\n\u8bf7\u5173\u95ed\u76ee\u6807\u76ee\u5f55\u4e2d\u8fd0\u884c\u7684\u5de5\u5177\uff0c\u6216\u68c0\u67e5\u672c\u5730\u4fee\u6539\u540e\u91cd\u8bd5\u3002", false)
		return err
	}
	if status.State == "publish" {
		if err = writeToolRecord(toolVersionRecord{Directory: target, Version: toVersion, HTML: targetHTML}); err != nil {
			return err
		}
	}
	fmt.Fprintln(os.Stdout, "Program updated; wave libraries were not changed.")
	return nil
}
