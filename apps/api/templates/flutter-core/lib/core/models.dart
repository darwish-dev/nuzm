import 'package:flutter/widgets.dart';

/// A text in both languages. `of` picks by the active locale (Arabic is a first-class language, not a translation of English).
class L {
  const L(this.ar, this.en);

  final String ar;
  final String en;

  String of(BuildContext context) =>
      Localizations.localeOf(context).languageCode == 'ar' ? ar : en;
}

enum ScreenKind { home, list, form, detail, settings }

enum FieldType { text, email, phone, number, password, multiline, choice, toggle }

class OptionDef {
  const OptionDef(this.value, this.label);

  final String value;
  final L label;
}

class FieldDef {
  const FieldDef({
    required this.id,
    required this.label,
    required this.type,
    this.required = false,
    this.options = const [],
  });

  final String id;
  final L label;
  final FieldType type;
  final bool required;
  final List<OptionDef> options;
}

class ItemDef {
  const ItemDef(this.title, [this.subtitle]);

  final L title;
  final L? subtitle;
}

class ScreenDef {
  const ScreenDef({
    required this.id,
    required this.title,
    required this.kind,
    this.body,
    this.fields = const [],
    this.items = const [],
  });

  final String id;
  final L title;
  final ScreenKind kind;
  final L? body;
  final List<FieldDef> fields;
  final List<ItemDef> items;
}
