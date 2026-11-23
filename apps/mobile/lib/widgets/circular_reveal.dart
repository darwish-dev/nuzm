import 'dart:math' as math;

import 'package:flutter/material.dart';

/// A route that opens as a circle growing out of [origin] (the button that opened it) while it fades in, and closes
/// by shrinking back into that point while it fades out. Without an origin it grows from the top start corner.
class CircularRevealRoute<T> extends PageRouteBuilder<T> {
  CircularRevealRoute({required WidgetBuilder builder, this.origin})
      : super(
          opaque: false,
          barrierColor: Colors.transparent,
          // Slow enough to see the circle open and close.
          transitionDuration: const Duration(milliseconds: 900),
          reverseTransitionDuration: const Duration(milliseconds: 700),
          pageBuilder: (context, _, __) => builder(context),
        );

  /// The centre of the circle, in global coordinates.
  final Offset? origin;

  /// The centre of [key]'s widget on screen, for [origin].
  static Offset? centerOf(GlobalKey key) {
    final box = key.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(box.size.center(Offset.zero));
  }

  @override
  Widget buildTransitions(BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation, Widget child) {
    if (MediaQuery.of(context).disableAnimations) return FadeTransition(opacity: animation, child: child);
    final grow = CurvedAnimation(parent: animation, curve: Curves.easeInOutCubic, reverseCurve: Curves.easeInOutCubic);
    final fade = CurvedAnimation(
      parent: animation,
      curve: const Interval(0, 0.6, curve: Curves.easeOut),
      reverseCurve: const Interval(0.3, 1, curve: Curves.easeIn),
    );
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) {
        final size = MediaQuery.sizeOf(context);
        final rtl = Directionality.of(context) == TextDirection.rtl;
        final c = origin ?? Offset(rtl ? size.width - 32 : 32, MediaQuery.paddingOf(context).top + 24);
        // Far enough to cover the farthest corner.
        final reach = [Offset.zero, Offset(size.width, 0), Offset(0, size.height), Offset(size.width, size.height)]
            .map((p) => (p - c).distance)
            .reduce(math.max);
        return ClipPath(
          clipper: _CircleClipper(c, 24 + (reach - 24) * grow.value),
          child: Opacity(opacity: fade.value, child: child),
        );
      },
    );
  }
}

class _CircleClipper extends CustomClipper<Path> {
  const _CircleClipper(this.center, this.radius);
  final Offset center;
  final double radius;

  @override
  Path getClip(Size size) => Path()..addOval(Rect.fromCircle(center: center, radius: radius));

  @override
  bool shouldReclip(_CircleClipper old) => old.center != center || old.radius != radius;
}
