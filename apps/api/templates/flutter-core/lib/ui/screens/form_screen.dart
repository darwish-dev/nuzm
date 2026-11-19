import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';

const _requiredMessage = L('هذا الحقل مطلوب', 'This field is required');
const _emailMessage = L('أدخل بريدًا إلكترونيًا صحيحًا', 'Enter a valid email address');
const _numberMessage = L('أدخل رقمًا صحيحًا', 'Enter a valid number');
const _phoneMessage = L('أدخل رقم هاتف صحيحًا', 'Enter a valid phone number');

/// Validation of one text value. Returns null when valid. Empty optional values are valid.
String? validateField(BuildContext context, FieldDef field, String? value) {
  final v = (value ?? '').trim();
  if (v.isEmpty) {
    return field.required ? _requiredMessage.of(context) : null;
  }
  switch (field.type) {
    case FieldType.email:
      return RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v)
          ? null
          : _emailMessage.of(context);
    case FieldType.number:
      return num.tryParse(v) == null ? _numberMessage.of(context) : null;
    case FieldType.phone:
      return RegExp(r'^\+?[0-9 ()-]{6,20}$').hasMatch(v)
          ? null
          : _phoneMessage.of(context);
    case FieldType.text:
    case FieldType.password:
    case FieldType.multiline:
    case FieldType.choice:
    case FieldType.toggle:
      return null;
  }
}

/// `form` screens: one input per field with validation, keyboard types, and a submit that keeps the values on the device (the generated back end contract is not part of the
/// template: connect `onSubmit` to your API).
class FormScreen extends StatefulWidget {
  const FormScreen({super.key, required this.def, this.onSubmit});

  final ScreenDef def;
  final void Function(Map<String, Object?> values)? onSubmit;

  @override
  State<FormScreen> createState() => _FormScreenState();
}

class _FormScreenState extends State<FormScreen> {
  final _formKey = GlobalKey<FormState>();
  final Map<String, Object?> _values = {};

  TextInputType _keyboard(FieldType t) {
    switch (t) {
      case FieldType.email:
        return TextInputType.emailAddress;
      case FieldType.number:
        return const TextInputType.numberWithOptions(decimal: true);
      case FieldType.phone:
        return TextInputType.phone;
      case FieldType.multiline:
        return TextInputType.multiline;
      case FieldType.text:
      case FieldType.password:
      case FieldType.choice:
      case FieldType.toggle:
        return TextInputType.text;
    }
  }

  Widget _input(BuildContext context, FieldDef f) {
    final label = f.label.of(context) + (f.required ? ' *' : '');
    switch (f.type) {
      case FieldType.choice:
        return DropdownButtonFormField<String>(
          decoration: InputDecoration(labelText: label),
          initialValue: _values[f.id] as String?,
          items: [
            for (final o in f.options)
              DropdownMenuItem(value: o.value, child: Text(o.label.of(context))),
          ],
          validator: (v) => validateField(context, f, v),
          onChanged: (v) => _values[f.id] = v,
        );
      case FieldType.toggle:
        return FormField<bool>(
          initialValue: (_values[f.id] as bool?) ?? false,
          builder: (state) => SwitchListTile(
            title: Text(f.label.of(context)),
            value: state.value ?? false,
            onChanged: (v) {
              _values[f.id] = v;
              state.didChange(v);
            },
          ),
        );
      case FieldType.text:
      case FieldType.email:
      case FieldType.phone:
      case FieldType.number:
      case FieldType.password:
      case FieldType.multiline:
        return TextFormField(
          key: ValueKey('field_${f.id}'),
          decoration: InputDecoration(labelText: label),
          keyboardType: _keyboard(f.type),
          obscureText: f.type == FieldType.password,
          maxLines: f.type == FieldType.multiline ? 4 : 1,
          inputFormatters: f.type == FieldType.phone
              ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9+() -]'))]
              : null,
          autofillHints: f.type == FieldType.email
              ? const [AutofillHints.email]
              : null,
          validator: (v) => validateField(context, f, v),
          onSaved: (v) => _values[f.id] = v?.trim(),
        );
    }
  }

  void _submit() {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) {
      return;
    }
    form.save();
    widget.onSubmit?.call(Map.unmodifiable(_values));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(const L('تم الحفظ على هذا الجهاز', 'Saved on this device').of(context)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.def.title.of(context))),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final f in widget.def.fields) ...[
              _input(context, f),
              const SizedBox(height: 16),
            ],
            FilledButton(
              key: const ValueKey('form_submit'),
              onPressed: _submit,
              child: Text(const L('إرسال', 'Submit').of(context)),
            ),
          ],
        ),
      ),
    );
  }
}
