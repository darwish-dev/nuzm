import 'package:flutter/widgets.dart';

/// The app's icon set: Phosphor (regular weight; phosphor_flutter's bundled font), in one place so the whole app stays
/// consistent. Names follow what each icon means in the app.
///
/// Built from the Phosphor glyphs directly so they do NOT mirror in Arabic: phosphor_flutter marks every icon
/// `matchTextDirection`, which turns ticks, bells and sparkles backwards. Direction-aware arrows are chosen by the
/// screens themselves (`ForwardChevron`, `backIcon`).
abstract final class NzIcons {
  static const IconData appWindow = _P(0xe5da); // appWindow
  static const IconData arrowLeftRight = _P(0xe0a0); // arrowsLeftRight
  static const IconData arrowUp = _P(0xe08e); // arrowUp
  static const IconData atSign = _P(0xe0ac); // at
  static const IconData badgeCheck = _P(0xe606); // sealCheck
  static const IconData ban = _P(0xe3de); // prohibit
  static const IconData bell = _P(0xe0ce); // bell
  static const IconData briefcase = _P(0xe0ee); // briefcase
  static const IconData building2 = _P(0xe102); // buildings
  static const IconData check = _P(0xe182); // check
  static const IconData checkCheck = _P(0xe53a); // checks
  static const IconData chevronLeft = _P(0xe138); // caretLeft
  static const IconData chevronRight = _P(0xe13a); // caretRight
  static const IconData chevronsUpDown = _P(0xe140); // caretUpDown
  static const IconData circleCheck = _P(0xe184); // checkCircle
  static const IconData clock = _P(0xe19a); // clock
  static const IconData cloud = _P(0xe1aa); // cloud
  static const IconData cloudOff = _P(0xe1b6); // cloudSlash
  static const IconData code = _P(0xe1bc); // code
  static const IconData container = _P(0xe1da); // cube
  static const IconData creditCard = _P(0xe1d2); // creditCard
  static const IconData database = _P(0xe1de); // database
  static const IconData eye = _P(0xe220); // eye
  static const IconData eyeOff = _P(0xe224); // eyeSlash
  static const IconData fileText = _P(0xe23a); // fileText
  static const IconData folderKanban = _P(0xeb54); // kanban
  static const IconData gauge = _P(0xe628); // gauge
  static const IconData globe = _P(0xe288); // globe
  static const IconData hammer = _P(0xe80e); // hammer
  static const IconData handshake = _P(0xe582); // handshake
  static const IconData hardDrive = _P(0xe29e); // hardDrive
  static const IconData inbox = _P(0xe4aa); // tray
  static const IconData info = _P(0xe2ce); // info
  static const IconData keyRound = _P(0xe2d6); // key
  static const IconData landmark = _P(0xe0b4); // bank
  static const IconData languages = _P(0xe4a2); // translate
  static const IconData layers = _P(0xe466); // stack
  static const IconData layoutDashboard = _P(0xe464); // squaresFour
  static const IconData layoutGrid = _P(0xe464); // squaresFour
  static const IconData layoutTemplate = _P(0xe6d6); // layout
  static const IconData link = _P(0xe2e2); // link
  static const IconData lock = _P(0xe2fa); // lock
  static const IconData logOut = _P(0xe42a); // signOut
  static const IconData mail = _P(0xe218); // envelopeSimple
  static const IconData menu = _P(0xe2f0); // list
  static const IconData messageCircle = _P(0xe168); // chatCircle
  static const IconData mic = _P(0xe326); // microphone
  static const IconData moon = _P(0xe330); // moon
  static const IconData network = _P(0xe67c); // treeStructure
  static const IconData pause = _P(0xe39e); // pause
  static const IconData penLine = _P(0xebc6); // pencilSimpleLine
  static const IconData piggyBank = _P(0xea04); // piggyBank
  static const IconData play = _P(0xe3d0); // play
  static const IconData plug = _P(0xe946); // plug
  static const IconData plus = _P(0xe3d4); // plus
  static const IconData power = _P(0xe3da); // power
  static const IconData receipt = _P(0xe3ec); // receipt
  static const IconData refreshCw = _P(0xe094); // arrowsClockwise
  static const IconData rocket = _P(0xe3fe); // rocketLaunch
  static const IconData rotateCw = _P(0xe036); // arrowClockwise
  static const IconData search = _P(0xe30c); // magnifyingGlass
  static const IconData send = _P(0xe398); // paperPlaneTilt
  static const IconData server = _P(0xe2a0); // hardDrives
  static const IconData shieldCheck = _P(0xe40c); // shieldCheck
  static const IconData shoppingBag = _P(0xe416); // shoppingBag
  static const IconData slidersHorizontal = _P(0xe434); // slidersHorizontal
  static const IconData smartphone = _P(0xe1e0); // deviceMobile
  static const IconData sparkles = _P(0xe6a2); // sparkle
  static const IconData square = _P(0xe46c); // stop
  static const IconData squarePen = _P(0xe34c); // notePencil
  static const IconData store = _P(0xe470); // storefront
  static const IconData sun = _P(0xe472); // sun
  static const IconData trash2 = _P(0xe4a6); // trash
  static const IconData trendingUp = _P(0xe4ae); // trendUp
  static const IconData triangleAlert = _P(0xe4e0); // warning
  static const IconData user = _P(0xe4c2); // user
  static const IconData userCog = _P(0xe4cc); // userGear
  static const IconData userMinus = _P(0xe4ce); // userMinus
  static const IconData userPlus = _P(0xe4d0); // userPlus
  static const IconData users = _P(0xe4d6); // users
  static const IconData wallet = _P(0xe68a); // wallet
  static const IconData webhook = _P(0xecae); // webhooksLogo
  static const IconData workflow = _P(0xe6ec); // flowArrow
  static const IconData x = _P(0xe4f6); // x
}

class _P extends IconData {
  const _P(super.codePoint) : super(fontFamily: 'PhosphorRegular', fontPackage: 'phosphor_flutter');
}
