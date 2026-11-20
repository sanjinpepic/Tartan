# Suunto Run 2: resource tree (firmware as of 14 Oct 2026)

The app walked this tree read-only, using ResourceMetadata (`GET f00003`) on the owner's watch. Each record's links are `[?, parent, next sibling, first child]`. The format below is `Name hexId ops n`, then the parameters each method takes (`m0` is GET; `m1` looks like PUT). `{X}` is a path parameter. Only the branches relevant to sync are kept here. The full log is in the conversation of 14 Oct 2026, and the paste ended partway through `/Message`.

## Where workouts live

```
Logbook 15f                          ← Movesense-style logbook
  Entries 2400 ops 1
  FreeSpace 2401 ops 1
  Header 2402 ops 1
  IsFull 2403 ops 3
  IsOpen 2404 ops 3
  Log 160
    {LogIndex} 161
      Flags 2405 ops 2
      Remove 2406 ops 1              ← never call
  LogIndexByTimestamp 2407 ops 1
  Logging 2408 ops 3
  SummarySync 162
    Command 2409 ops 1               ← command, never call
    Progress 240a ops 2
    SyncState 240b ops 2
  SyncToDb 240c ops 1                ← command, never call
  UnsynchronisedLogs 240d ops 3
  byId 163
    {LogId} 164
      Data 240e ops 3
      Descriptors 240f ops 1
      Flags 2410 ops 2
      Remove 2411 ops 1              ← never call
      Summary 2412 ops 1
  isDelete 2413 ops 1
  removeAll 2414 ops 1               ← never call

Activity 10e
  Log 11b
    Count 32a ops 3
    {LogIndex} 11c
      IsSupervised 32b ops 1
      MoveData 32c ops 1
      StepsCount 32d ops 1
      Zapp 11d / {ZappIndex} 32f
      {Window} 11e
        Count 330
        {WindowIndex} 11f            ← per-lap/window aggregates (HR, speed, distance…)
  Logs 167
    SyncCommand 3000 ops 1           ← command, never call
    SyncProgress 3001 ops 3
    SyncState 3002 ops 3
  Moments 21c / Sync 21d / Data ab00 ops 1
  TrainingLab 21e / StressBalance ab03, TrendData ab05 (used by the Suunto app's sync)
DataFormat 1a1 / Descriptors 4a00 ops 1
Daily 232 / Sleep 233 / Timeline 234 / Data 4600 ops 1
```

## File system

```
Dev 240 / FileSystem 241
  DirectoryCreate 2300   m1(DirectoryName:STRING)
  DirectoryDelete 2301   m1(DirectoryName:STRING)
  DirectoryList   b000   m0(Path:STRING, Page:UINT8)     ← answers 400 to every path we tried
  EmmcFormat      2302   m1()                            ← formats storage; f02302 was DirectoryList on older watches
  FileCrc32       b001   m0(FileName:STRING)
  FileDelete      2303   m1(FileName:STRING)
  FileRename      2304   m1(OldName:STRING, NewName:STRING)
  FileSize        2305   m0(FileName:STRING)
  Info            2306   m0(Volume:UINT8?)
  Status          2307   m0(Volume:UINT8?)
  StorageInfo     2308   m0(type:UINT8?)
  Stream          b002   m0(FileName:STRING, offset:INT32?) m1(FileName:STRING, Data:BYTES)
  Version         2309   m0()
Dev 240 / System 1a6     (Lp* versions, Memory/*, Time 2700…)
Info 2f00 / Version 1ab / Ble Fs Gps Hw Ohr Product Sw Touch Wifi
```

## Top level

Activity, Analytics, AutoTest, BES, Communication, Daily, DataFormat, Dev, Device (components, connectivity: BLE, Wi-Fi, GNSS, NFC, power), Factory, FindPhone, Fusion, HelloWorld, Info, Logbook, MapsDownload, Meas, Media and Message. The list stops at Message, where the pasted log was cut off.

## The rest of the tree (build 2126, from Message on)

Logged on 14 Oct at 23:31, with 598 resources in total. `← Suunto app` marks a resource the Suunto app used during the same session.

```
Message 1f4 / History …                         (phone notification history)
Meta 109                                        (the metadata resources: Resource 3, Operation 4, Response 5, Parameter 7, DataType b, String c, Hash e…)
Navigation 185 / Poi, Routes, Gps, Targetlocation, QuickNavi
Net 100; NeteaseMusic 1ef; offline 22a/music
Network 22f / Dns/Resolution ae00, Socket/{Close,Connect,Read,Request,Write} ae01–ae05
Planned 175 / Moves 176 …                       (planned workouts: AddMove, Current, WeeklyTarget, {List}/{Index}/…)
Plugin 21b / Install, InstallAid, List, TestInfo, Uninstall (aa00–aa04)
Settings 22e / … Device/AppInfo 3400 ← app, Unit/UnitsMode 3a01 ← app, User/launcherStatus 3a2d ← app,
             Wifi 1e6 / Cloud 1e7 / OfflineMaps/Url b504 ← app, STTAuthorization b505 ← app (m1 value:STRING),
             GeneralSettings b506 ← app
SportMode2 221; Storage 220/Widgets; TeamLive 23f; Test 1dd
Sync 212 / BusyState 4c01 (/Ui 4c02), FindPhoneBusyState, MediaBusyState, Status 4c05
TrainingZone 21a / TrainingData a901 / LatestSyncTime a902
Update 1a0 / … Force/Tag 5a07 ← app, Info 5a09 ← app, Transfer/*, Backup/Start, FullReset (never call)
Voice 217 / AutoLap 9400 ← app (SUBSCRIBE), HeartRateZone 9401 ← app (SUBSCRIBE), Status 9402
WatchFace 23c / … Lists b309 ← app (m0 startAfterId:STRING?)
Weather 236 / … Sync 910c ← app (SUBSCRIBE), Sync/LastTime 910d ← app
Whiteboard 10a / Info/Subscriptions, Metrics/*, System/Launcher
WifiDownload 1f2
```

## What this means for syncing workouts

Across five sessions the Suunto app's sync used settings, weather, watch faces, update info, the daily-health feeds (TrendData, StressBalance, Moments, the sleep timeline) and cloud setup (STTAuthorization is a Sports Tracker token, plus Wi-Fi settings). It never used anything workout-related.

On the workout side:
- `/Activity/Log` and `/Activity/Logs` answer 503 to reads and to SyncCommand.
- `/Logbook` is empty.
- `/Dev/FileSystem/DirectoryList` refuses every path.

The watch has its own Wi-Fi upload (`/Device/Connectivity/Wifi/Upload/File`) and network sockets. The most likely explanation is that the Run 2 uploads workouts to Suunto's cloud itself, and there is no Bluetooth workout transfer a third-party app can use. An Android HCI snoop capture of a fresh workout syncing would confirm it.
