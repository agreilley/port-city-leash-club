# Port City Leash Club — Open Items

Running list of things to work on. Add to this as new items come up; check items off (or remove) once done.

---

## Website / Content

- [ ] **Cats and other pets are missing from Pet Sitting Services.** The site currently only talks about dogs (dog walking, dog details forms, etc.), but drop-in visits and overnight stays should also cover other pets — cats especially. Needs:
  - Homepage Pet Sitting Services copy/cards reviewed for dog-only language
  - Service request form: "Dog Details" section either renamed/generalized or a parallel path added for non-dog pets
  - New FAQ entry answering "Do you take care of pets other than dogs?" (or similar)

## Known Issues

- [ ] `service-request.html` submit button is a non-functional mockup (`onclick="alert('Mockup only...')"`) — the form doesn't actually save anywhere yet. Needs real Firestore submission wiring, similar to `membership-request.html`.
- [ ] "Extra pet +$20" add-on checkbox on the service request page is disconnected from the new multi-dog card system — someone could add 2+ dog cards without checking the add-on, or vice versa. Worth deciding whether pricing should auto-derive from number of dog cards instead of a manual checkbox.

## Still Open From Earlier Sessions

- [ ] Firestore: add `"travel"` as a valid `tier` value for pet-sitting-only clients (no active walk membership)
- [ ] Payment placement: decide where in the flow Stripe actually charges the card — deposit/hold now vs. full charge after meet & greet confirmation
- [ ] Launch timeline: remove "Now booking for our August 2026 launch" language from the hero once walks actually start (mental deadline: August 15, adjust as needed)
