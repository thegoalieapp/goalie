# Adds Goalie's app-lock pieces to the Xcode project: the GoalieLocks plugin in the app, and the three
# Screen Time helpers (re-locker, lock screen, lock screen buttons) as app extensions embedded in it.
# Safe to run more than once. Needs a Mac with Ruby's xcodeproj gem (the cloud build runs it):
#   ruby tools/add-lock-targets.rb
require 'xcodeproj'

IOS = File.expand_path('../ios/App', __dir__)
project = Xcodeproj::Project.open(File.join(IOS, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' } or abort('No App target')
app_group = project.main_group['App'] or abort('No App group')

def file_in(group, name)
  group.files.find { |f| f.path == name } || group.new_reference(name)
end

# The app: the plugin, the shared lock data, and the screen that registers the plugin.
locks_group = app_group['GoalieLocks'] || app_group.new_group('GoalieLocks', 'GoalieLocks')
shared = file_in(locks_group, 'LockShared.swift')
[shared, file_in(locks_group, 'GoalieLocksPlugin.swift'), file_in(app_group, 'MainViewController.swift')].each do |ref|
  app.source_build_phase.add_file_reference(ref, true)
end
app.add_system_frameworks(%w[FamilyControls ManagedSettings DeviceActivity])
app.build_configurations.each { |c| c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0' }

EXTENSIONS = [
  ['GoalieMonitor', 'com.thegoalieapp.goalie.monitor', %w[DeviceActivity ManagedSettings FamilyControls]],
  ['GoalieShield', 'com.thegoalieapp.goalie.shield', %w[ManagedSettings ManagedSettingsUI FamilyControls]],
  ['GoalieShieldAction', 'com.thegoalieapp.goalie.shieldaction', %w[ManagedSettings FamilyControls UserNotifications]],
].freeze

embed = app.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins }
unless embed
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
end

EXTENSIONS.each do |name, bundle_id, frameworks|
  next if project.targets.any? { |t| t.name == name }

  target = project.new_target(:app_extension, name, :ios, '16.0', nil, :swift)
  group = project.main_group[name] || project.main_group.new_group(name, name)
  Dir.glob(File.join(IOS, name, '*.swift')).sort.each do |path|
    target.source_build_phase.add_file_reference(file_in(group, File.basename(path)), true)
  end
  target.source_build_phase.add_file_reference(shared, true)
  Dir.glob(File.join(IOS, name, '*.png')).sort.each do |path|
    target.resources_build_phase.add_file_reference(file_in(group, File.basename(path)), true)
  end
  file_in(group, 'Info.plist')
  file_in(group, "#{name}.entitlements")
  target.add_system_frameworks(frameworks)

  target.build_configurations.each do |config|
    s = config.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = bundle_id
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{name}/Info.plist"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{name}/#{name}.entitlements"
    s['CODE_SIGN_STYLE'] = 'Automatic'
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
    s['MARKETING_VERSION'] = '1.0'
    s['CURRENT_PROJECT_VERSION'] = '1'
    s['SKIP_INSTALL'] = 'YES'
    s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  end

  app.add_dependency(target)
  embed.add_file_reference(target.product_reference, true).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  puts "Added #{name} (#{bundle_id})"
end

project.save
puts 'Lock targets ready.'
