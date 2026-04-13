package com.swp391.datalabeling.entity;

import jakarta.persistence.*;
import lombok.*;

import java.util.List;

@Entity
@Table(name = "label_classes")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class LabelClass {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(length = 10)
    private String color;

    @Column(columnDefinition = "TEXT")
    private String description;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "project_id", nullable = false)
    private Project project;

    @OneToMany(mappedBy = "labelClass", fetch = FetchType.LAZY)
    private List<Annotation> annotations;
}
